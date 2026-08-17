const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protect, authorize } = require('../middleware/authMiddleware');
const StudyPlan = require('../models/StudyPlan');
const TestAttempt = require('../models/TestAttempt');
const Doubt = require('../models/Doubt');
const CourseDocChunk = require('../models/CourseDocChunk');
const User = require('../models/User');
const Test = require('../models/Test');
const GradedSubmission = require('../models/GradedSubmission');
const { generateChatCompletion } = require('../services/groqService');
const { retrieveRelevantChunks, formatGroundedContext, ingestDocument } = require('../services/ragService');
const { extractTextFromFile } = require('../services/fileParserService');

// Multer memory storage for student uploads (PDF, Text, Timetables, Study materials)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB limit
});

// All student routes are protected and restricted to student role
router.use(protect);
router.use(authorize('student'));

// ==========================================
// DYNAMIC COURSE CATALOG & PROFESSOR MATERIALS DISCOVERY (READ-ONLY)
// ==========================================

// @route   GET /api/student/courses
// @desc    Get all distinct courses & subjects dynamically available in the university RAG repository (Disabled - Faculty-Student isolation)
router.get('/courses', async (req, res) => {
  res.json([]);
});

// @route   GET /api/student/course-materials
// @desc    Search and browse professor-uploaded course materials by subject and subjectCode (Disabled - Faculty-Student isolation)
router.get('/course-materials', async (req, res) => {
  res.json([]);
});

// @route   GET /api/student/course-materials/preview
// @desc    Preview text chunks of a specific document for student study (Disabled - Faculty-Student isolation)
router.get('/course-materials/preview', async (req, res) => {
  res.json([]);
});

// ==========================================
// 1. STUDENT DASHBOARD
// ==========================================
router.get('/dashboard', async (req, res) => {
  try {
    const studentId = req.user._id;

    const [studyPlans, testAttempts, doubts] = await Promise.all([
      StudyPlan.find({ userId: studentId }).sort({ createdAt: -1 }).limit(5),
      TestAttempt.find({ userId: studentId }).sort({ completedAt: -1 }).limit(10),
      Doubt.find({ userId: studentId }).sort({ createdAt: -1 }).limit(5),
    ]);

    const totalPlans = await StudyPlan.countDocuments({ userId: studentId });
    const totalTests = await TestAttempt.countDocuments({ userId: studentId, isReleased: { $ne: false } });
    const totalDoubts = await Doubt.countDocuments({ userId: studentId });

    // Calculate average test percentage using only released attempts
    let avgScore = 0;
    const weakAreasSet = new Set();
    const strengthsSet = new Set();

    const releasedAttempts = await TestAttempt.find({ userId: studentId, isReleased: { $ne: false } });
    if (releasedAttempts.length > 0) {
      const sum = releasedAttempts.reduce((acc, curr) => acc + (curr.percentage || 0), 0);
      avgScore = Math.round(sum / releasedAttempts.length);
      releasedAttempts.forEach((t) => {
        t.weakAreas?.forEach((w) => weakAreasSet.add(w));
        t.strengths?.forEach((s) => strengthsSet.add(s));
      });
    }

    res.json({
      stats: {
        totalPlans,
        totalTests,
        totalDoubts,
        avgScore,
        weakAreas: Array.from(weakAreasSet).slice(0, 5),
        strengths: Array.from(strengthsSet).slice(0, 5),
      },
      recentPlans: studyPlans,
      recentTests: testAttempts,
      recentDoubts: doubts,
    });
  } catch (error) {
    console.error('[StudentDashboard] Error:', error);
    res.status(500).json({ error: 'Failed to load dashboard metrics.' });
  }
});

// ==========================================
// 2. STUDENT STUDY PLANNER (MULTI-FILE UPLOAD, PRIORITIES & CUSTOMIZABLE)
// ==========================================
// @route   POST /api/student/study-plans/generate-from-materials
// @desc    Generate personalized study plan from uploaded syllabus, timetable, course outline, or study material
router.post(
  '/study-plans/generate-from-materials',
  upload.fields([
    { name: 'syllabusFile', maxCount: 1 },
    { name: 'timetableFile', maxCount: 1 },
    { name: 'studyMaterialFile', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        subject = 'Computer Science',
        subjectCode = '',
        department = 'CSE',
        topic = 'Comprehensive Exam Prep',
        targetExamDate,
        durationDays = 7,
        rawNotes = '',
        selectedDocTitle = '',
      } = req.body;

      let extractedContext = rawNotes || '';

      // Process uploaded syllabus
      if (req.files?.syllabusFile?.[0]) {
        const file = req.files.syllabusFile[0];
        const text = await extractTextFromFile({
          fileBuffer: file.buffer,
          originalName: file.originalname,
          mimeType: file.mimetype,
        });
        extractedContext += `\n[UPLOADED SYLLABUS: ${file.originalname}]\n${text}`;
        await ingestDocument({
          uploadedBy: req.user._id,
          docTitle: `Syllabus - ${file.originalname.replace(/\.[^/.]+$/, '')}`,
          subject,
          subjectCode: subjectCode || '',
          department: department || 'CSE',
          type: 'syllabus',
          rawText: text,
        });
      }

      // Process uploaded timetable / exam schedule
      if (req.files?.timetableFile?.[0]) {
        const file = req.files.timetableFile[0];
        const text = await extractTextFromFile({
          fileBuffer: file.buffer,
          originalName: file.originalname,
          mimeType: file.mimetype,
        });
        extractedContext += `\n[TIMETABLE & EXAM SCHEDULE: ${file.originalname}]\n${text}`;
      }

      // Process uploaded study material
      if (req.files?.studyMaterialFile?.[0]) {
        const file = req.files.studyMaterialFile[0];
        const text = await extractTextFromFile({
          fileBuffer: file.buffer,
          originalName: file.originalname,
          mimeType: file.mimetype,
        });
        extractedContext += `\n[COURSE STUDY MATERIAL: ${file.originalname}]\n${text}`;
        await ingestDocument({
          uploadedBy: req.user._id,
          docTitle: `Study Material - ${file.originalname.replace(/\.[^/.]+$/, '')}`,
          subject,
          subjectCode: subjectCode || '',
          department: department || 'CSE',
          type: 'content',
          rawText: text,
        });
      }

      // Retrieve additional context from student's isolated RAG vault filtered by subjectCode
      const relevantChunks = await retrieveRelevantChunks({
        subject,
        subjectCode: subjectCode || null,
        department: department || null,
        query: `${topic} ${subject} ${subjectCode} ${selectedDocTitle} syllabus curriculum exam roadmap`,
        topK: 4,
        userId: req.user._id,
        docTitle: selectedDocTitle || null,
      });
      const groundedContext = formatGroundedContext(relevantChunks);

      const prompt = `You are an Expert AI Academic Coach creating a personalized, high-yield study planner for a student.
Subject: ${subject}
Focus Topic / Goal: ${topic}
Target Exam Date: ${targetExamDate || 'Upcoming Exam'}
Schedule Duration: ${durationDays} days

UPLOADED COURSE SYLLABUS, TIMETABLE & STUDY MATERIAL:
"""
${(extractedContext + '\n\n' + groundedContext).slice(0, 7000)}
"""

Instructions:
1. Generate an actionable, day-by-day study roadmap for ${durationDays} days.
2. For each day, assign:
   - day number
   - title
   - subject
   - focus objective
   - priority level ("High", "Medium", or "Low")
   - recommended daily study time in minutes (e.g. 60, 90, 120)
   - scheduled date (sequential dates starting from today or target exam timeline)
   - 2-4 concrete, actionable daily tasks
3. Synthesize a concise topic summary and formatted Markdown revision notes.

Return ONLY valid JSON matching this exact structure:
{
  "topicSummary": "Concise high-yield topic overview",
  "planDays": [
    {
      "day": 1,
      "title": "Core Foundations & Axioms",
      "subject": "${subject}",
      "focus": "Mastering fundamental definitions and basic proofs",
      "priority": "High",
      "scheduledDate": "${new Date().toISOString().split('T')[0]}",
      "recommendedStudyMinutes": 90,
      "tasks": ["Read Chapter 1 notes", "Solve 5 foundational problems", "Draft summary flashcards"]
    }
  ],
  "revisionNotes": "Markdown formatted cheat sheet with key formulas, core theorems, and common traps."
}`;

      const completion = await generateChatCompletion({
        messages: [
          { role: 'system', content: 'You are an academic study planner. Output strictly JSON.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      });

      let parsed;
      try {
        parsed = JSON.parse(completion);
      } catch (err) {
        const jsonMatch = completion.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      }

      const planDaysWithStatus = (parsed?.planDays || []).map((d) => ({
        ...d,
        completed: false,
      }));

      const plan = await StudyPlan.create({
        userId: req.user._id,
        subject,
        topic,
        targetExamDate: targetExamDate || '',
        syllabusRef: req.files?.syllabusFile?.[0]?.originalname || 'Uploaded Material',
        durationDays: Number(durationDays),
        planDays: planDaysWithStatus,
        topicSummary: parsed?.topicSummary || 'Personalized study schedule.',
        revisionNotes: parsed?.revisionNotes || 'Review key concepts and formulas.',
        progressPercent: 0,
      });

      res.status(201).json(plan);
    } catch (error) {
      console.error('[StudyPlanGenerateFromMaterials] Error:', error);
      res.status(500).json({ error: error.message || 'Failed to generate study plan.' });
    }
  }
);

// Standard post route alias
router.post('/study-plans', async (req, res) => {
  try {
    const { subject, topic, targetExamDate, durationDays = 7, syllabusRef = '' } = req.body;

    const relevantChunks = await retrieveRelevantChunks({
      subject,
      query: `${topic} ${syllabusRef}`,
      topK: 3,
      userId: req.user._id,
    });
    const groundedContext = formatGroundedContext(relevantChunks);

    const prompt = `You are an expert AI Academic Coach generating an individualized study plan for a student.
Subject: ${subject}
Topic / Exam Goal: ${topic}
Target Exam Date: ${targetExamDate || 'Upcoming Exam'}
Duration: ${durationDays} days
Syllabus / Reference Notes: ${syllabusRef || 'Standard Curriculum'}

COURSE REFERENCE MATERIALS (GROUNDING CONTEXT):
${groundedContext}

Generate ${durationDays}-day schedule. Return ONLY valid JSON:
{
  "topicSummary": "Overview",
  "planDays": [
    {
      "day": 1,
      "title": "Title",
      "subject": "${subject}",
      "focus": "Focus",
      "priority": "High",
      "scheduledDate": "${new Date().toISOString().split('T')[0]}",
      "recommendedStudyMinutes": 90,
      "tasks": ["Task 1", "Task 2"]
    }
  ],
  "revisionNotes": "Markdown revision notes"
}`;

    const completion = await generateChatCompletion({
      messages: [
        { role: 'system', content: 'You are an academic mentor. Output ONLY JSON.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    });

    let parsed;
    try {
      parsed = JSON.parse(completion);
    } catch (err) {
      const match = completion.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }

    const plan = await StudyPlan.create({
      userId: req.user._id,
      subject,
      topic,
      targetExamDate: targetExamDate || '',
      syllabusRef,
      durationDays,
      planDays: parsed?.planDays || [],
      topicSummary: parsed?.topicSummary || '',
      revisionNotes: parsed?.revisionNotes || '',
      progressPercent: 0,
    });

    res.status(201).json(plan);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to generate study plan.' });
  }
});

// @route   PUT /api/student/study-plans/:id
// @desc    Edit study plan days, tasks, priorities, or study minutes
router.put('/study-plans/:id', async (req, res) => {
  try {
    const { topic, targetExamDate, planDays, topicSummary, revisionNotes } = req.body;
    const plan = await StudyPlan.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!plan) {
      return res.status(404).json({ error: 'Study plan not found or access denied.' });
    }

    if (topic) plan.topic = topic;
    if (targetExamDate !== undefined) plan.targetExamDate = targetExamDate;
    if (topicSummary !== undefined) plan.topicSummary = topicSummary;
    if (revisionNotes !== undefined) plan.revisionNotes = revisionNotes;
    if (planDays && Array.isArray(planDays)) {
      plan.planDays = planDays;
      const completedCount = planDays.filter((d) => d.completed).length;
      plan.progressPercent = Math.round((completedCount / (planDays.length || 1)) * 100);
    }

    await plan.save();
    res.json(plan);
  } catch (error) {
    console.error('[StudyPlanEdit] Error:', error);
    res.status(500).json({ error: 'Failed to update study plan.' });
  }
});

// @route   GET /api/student/study-plans
// @desc    List all study plans for the logged-in student
router.get('/study-plans', async (req, res) => {
  try {
    const plans = await StudyPlan.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch study plans.' });
  }
});

// @route   GET /api/student/study-plans/:id
// @desc    Get single study plan
router.get('/study-plans/:id', async (req, res) => {
  try {
    const plan = await StudyPlan.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!plan) {
      return res.status(404).json({ error: 'Study plan not found.' });
    }
    res.json(plan);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch study plan.' });
  }
});

// @route   DELETE /api/student/study-plans/:id
// @desc    Delete a study plan for the logged-in student
router.delete('/study-plans/:id', async (req, res) => {
  try {
    const plan = await StudyPlan.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!plan) {
      return res.status(404).json({ error: 'Study plan not found or access denied.' });
    }

    res.json({ message: 'Study plan deleted successfully.', id: req.params.id });
  } catch (error) {
    console.error('[StudyPlanDelete] Error:', error);
    res.status(500).json({ error: 'Failed to delete study plan.' });
  }
});

// @route   PATCH /api/student/study-plans/:id/toggle-task
// @desc    Toggle completion of a daily plan task
router.patch('/study-plans/:id/toggle-task', async (req, res) => {
  try {
    const { dayIndex } = req.body;
    const plan = await StudyPlan.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!plan) {
      return res.status(404).json({ error: 'Study plan not found.' });
    }

    if (plan.planDays[dayIndex]) {
      plan.planDays[dayIndex].completed = !plan.planDays[dayIndex].completed;
      const completedCount = plan.planDays.filter((d) => d.completed).length;
      plan.progressPercent = Math.round((completedCount / plan.planDays.length) * 100);
      await plan.save();
    }

    res.json(plan);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update task status.' });
  }
});

// ==========================================
// SCOPED ASSIGNED TESTS (OPTION A SCOPING & OPTION B ACCESS CODES)
// ==========================================

// @route   GET /api/student/available-tests
// @desc    Fetch tests available for the student based on Option A automatic scoping
router.get('/available-tests', async (req, res) => {
  try {
    const student = req.user;

    // Build Option A filter criteria
    const filter = {
      isPublished: true,
    };

    if (student.department) {
      filter.department = { $regex: new RegExp(`^${student.department.trim()}$`, 'i') };
    }
    if (student.year) {
      filter.year = { $regex: new RegExp(`^${student.year.trim()}$`, 'i') };
    }
    if (student.enrolledSubjects && student.enrolledSubjects.length > 0) {
      filter.subjectCode = {
        $in: student.enrolledSubjects.map((code) => new RegExp(`^${code.trim()}$`, 'i')),
      };
    }

    const tests = await Test.find(filter).sort({ createdAt: -1 });

    // Return tests without exposing answers before access code validation
    const sanitizedTests = tests.map((t) => ({
      _id: t._id,
      title: t.title,
      topic: t.topic,
      department: t.department,
      year: t.year,
      semester: t.semester,
      subjectCode: t.subjectCode,
      subject: t.subject,
      difficulty: t.difficulty,
      durationMinutes: t.durationMinutes,
      questionCount: t.questions?.length || 0,
      requiresAccessCode: Boolean(t.accessCode && t.accessCode.trim().length > 0),
      createdAt: t.createdAt,
      professorName: t.professorName || '',
      courseId: t.courseId || '',
    }));

    res.json(sanitizedTests);
  } catch (error) {
    console.error('[AvailableTests] Error:', error);
    res.status(500).json({ error: 'Failed to fetch available tests.' });
  }
});

// @route   POST /api/student/tests/unlock-by-code
// @desc    Unlock and start a test by code (Fully Access Code based, no Option A filters)
router.post('/tests/unlock-by-code', async (req, res) => {
  try {
    const { accessCode = '' } = req.body;
    if (!accessCode || !accessCode.trim()) {
      return res.status(400).json({ error: 'Access Code is required.' });
    }

    const testDoc = await Test.findOne({
      accessCode: { $regex: new RegExp(`^${accessCode.trim()}$`, 'i') },
      isPublished: true,
    });

    if (!testDoc) {
      return res.status(404).json({
        error: 'No active assessment exam matches the provided access code. Please verify the code and try again.',
      });
    }

    // Check if the student has already taken this test
    const existingAttempt = await TestAttempt.findOne({
      userId: req.user._id,
      testId: testDoc._id,
    });

    if (existingAttempt) {
      return res.status(400).json({
        error: 'You have already submitted this exam. Officially assigned exams can only be taken once.',
      });
    }

    // Return full test document (including questions) for running the test
    res.json(testDoc);
  } catch (error) {
    console.error('[UnlockTestByCode] Error:', error);
    res.status(500).json({ error: 'Failed to access test.' });
  }
});

// @route   POST /api/student/tests/:id/start
// @desc    Start/fetch full test with server-side Option A check & Option B access code verification
router.post('/tests/:id/start', async (req, res) => {
  try {
    const student = req.user;
    const { accessCode = '' } = req.body;

    const testDoc = await Test.findById(req.params.id);
    if (!testDoc || !testDoc.isPublished) {
      return res.status(404).json({ error: 'Test not found or unavailable.' });
    }

    // 1. OPTION A GATEWAY VERIFICATION (Primary, Mandatory)
    if (student.department && testDoc.department.toLowerCase() !== student.department.toLowerCase()) {
      return res.status(403).json({ error: 'Access Denied: Test department does not match your enrolled department.' });
    }
    if (student.year && testDoc.year.toLowerCase() !== student.year.toLowerCase()) {
      return res.status(403).json({ error: 'Access Denied: Test year does not match your current academic year.' });
    }
    if (
      student.enrolledSubjects &&
      student.enrolledSubjects.length > 0 &&
      !student.enrolledSubjects.some((s) => s.toLowerCase() === testDoc.subjectCode.toLowerCase())
    ) {
      return res.status(403).json({ error: 'Access Denied: You are not enrolled in this subject code.' });
    }

    // 2. OPTION B GATEWAY VERIFICATION (Secondary, Optional)
    if (testDoc.accessCode && testDoc.accessCode.trim().length > 0) {
      if (!accessCode || accessCode.trim() !== testDoc.accessCode.trim()) {
        return res.status(403).json({
          error: 'Invalid or missing Access Code. Please enter the correct code provided by your professor.',
        });
      }
    }

    // Return full test document (including questions) for running the test
    res.json(testDoc);
  } catch (error) {
    console.error('[StartTest] Error:', error);
    res.status(500).json({ error: 'Failed to access test.' });
  }
});

// ==========================================
// 3. STUDENT MATERIAL-BASED SAMPLE TEST (MCQs, TRUE/FALSE, FILL-BLANK, SHORT-ANSWER)
// ==========================================
// @route   POST /api/student/tests/generate-from-material
// @desc    Generate multi-type test questions from uploaded material or RAG vault
router.post('/tests/generate-from-material', upload.single('file'), async (req, res) => {
  try {
    const {
      subject = 'Computer Science',
      subjectCode = '',
      department = 'CSE',
      topic = 'Comprehensive Exam',
      difficulty = 'Medium',
      questionCount = 5,
      questionType = 'Mixed', // 'MCQ' | 'TrueFalse' | 'FillBlank' | 'ShortAnswer' | 'Mixed'
      rawText = '',
      selectedDocTitle = '',
    } = req.body;

    let materialContent = rawText || '';

    // If student attached a document directly to the quiz generator
    if (req.file) {
      materialContent = await extractTextFromFile({
        fileBuffer: req.file.buffer,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
      });

      if (materialContent && materialContent.trim().length > 20) {
        await ingestDocument({
          uploadedBy: req.user._id,
          docTitle: req.file.originalname.replace(/\.[^/.]+$/, ''),
          subject,
          subjectCode: subjectCode || '',
          department: department || 'CSE',
          type: 'content',
          rawText: materialContent,
        });
      }
    }

    // Retrieve from student's private RAG vault (scoped by subjectCode)
    const relevantChunks = await retrieveRelevantChunks({
      subject,
      subjectCode: subjectCode || null,
      department: department || null,
      query: `${topic} ${subjectCode} ${selectedDocTitle} ${materialContent.slice(0, 200)} practice examination questions`,
      topK: 4,
      userId: req.user._id,
      docTitle: selectedDocTitle || null,
    });
    let groundedContext = formatGroundedContext(relevantChunks);
    if (materialContent && materialContent.trim().length > 20) {
      groundedContext = `[ATTACHED STUDY MATERIAL]\n${materialContent.slice(0, 4000)}\n\n` + groundedContext;
    }

    // Retrieve past weak areas for adaptive question formulation
    const pastAttempts = await TestAttempt.find({ userId: req.user._id })
      .sort({ completedAt: -1 })
      .limit(3);
    const knownWeakAreas = [];
    pastAttempts.forEach((p) => p.weakAreas?.forEach((w) => knownWeakAreas.push(w)));

    const prompt = `You are an Expert AI Examiner creating a high-quality practice test for a student grounded strictly in their study material.
Subject: ${subject}
Topic: ${topic}
Difficulty Level: ${difficulty}
Total Questions: ${questionCount}
Question Type Format: ${questionType} (Support MCQ, TrueFalse, FillBlank, and ShortAnswer)
Student's Known Historical Weak Areas: ${knownWeakAreas.length > 0 ? knownWeakAreas.join(', ') : 'None recorded'}

STUDY MATERIAL REFERENCE (GROUNDING):
${groundedContext}

Instructions:
Create exactly ${questionCount} questions grounded in the material.
Supported questionType values:
- "MCQ": options (4 choices), correctAnswerIndex (0-3), explanation
- "TrueFalse": options (["True", "False"]), correctAnswerIndex (0 or 1), explanation
- "FillBlank": question with a blank "_____", correctTextAnswer (the exact term), explanation
- "ShortAnswer": question requiring 1-3 sentences, correctTextAnswer (model answer & key points), explanation

Return ONLY valid JSON matching this exact structure:
{
  "questions": [
    {
      "questionType": "MCQ",
      "question": "Question text here?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswerIndex": 0,
      "correctTextAnswer": "Option A",
      "points": 2,
      "explanation": "Clear explanation of why this is correct.",
      "topicTag": "Subtopic Name"
    },
    {
      "questionType": "FillBlank",
      "question": "In the Raft protocol, leader election uses randomized _____ between 150ms and 300ms.",
      "options": [],
      "correctAnswerIndex": 0,
      "correctTextAnswer": "election timers",
      "points": 2,
      "explanation": "Randomized election timers prevent split votes in consensus.",
      "topicTag": "Consensus Protocols"
    },
    {
      "questionType": "ShortAnswer",
      "question": "Explain how Dijkstra algorithm avoids cycles in shortest-path trees.",
      "options": [],
      "correctAnswerIndex": 0,
      "correctTextAnswer": "Maintains visited set and greedily extracts minimum distance vertex from priority queue.",
      "points": 4,
      "explanation": "Greedy relaxation with non-negative edge weights guarantees optimal substructure.",
      "topicTag": "Graph Algorithms"
    }
  ]
}`;

    const completion = await generateChatCompletion({
      messages: [
        { role: 'system', content: 'You are an examination engine. Output strictly JSON.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    });

    let parsed;
    try {
      parsed = JSON.parse(completion);
    } catch (err) {
      const match = completion.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { questions: [] };
    }

    res.json({
      subject,
      topic,
      difficulty,
      questionTypeFilter: questionType,
      sourceMaterialTitle: req.file?.originalname || 'Personal Knowledge Vault',
      questions: parsed?.questions || [],
    });
  } catch (error) {
    console.error('[TestGenerateFromMaterial] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate test.' });
  }
});

// Standard generate test alias
router.post('/tests/generate', async (req, res) => {
  try {
    const { subject, topic, difficulty = 'Medium', questionCount = 4 } = req.body;
    const relevantChunks = await retrieveRelevantChunks({
      subject,
      query: `${topic} practice test`,
      topK: 3,
      userId: req.user._id,
    });
    const groundedContext = formatGroundedContext(relevantChunks);

    const prompt = `Create ${questionCount} multiple choice practice questions on "${topic}" for ${subject} (${difficulty}).
COURSE GROUNDING:
${groundedContext}
Return JSON matching: {"questions": [{"questionType": "MCQ", "question": "...", "options": ["A","B","C","D"], "correctAnswerIndex": 0, "correctTextAnswer": "...", "points": 1, "explanation": "...", "topicTag": "..."}]}`;

    const completion = await generateChatCompletion({
      messages: [
        { role: 'system', content: 'You are an examination engine. Output JSON.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    });

    let parsed;
    try {
      parsed = JSON.parse(completion);
    } catch (err) {
      const match = completion.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { questions: [] };
    }

    res.json({
      subject,
      topic,
      difficulty,
      questions: parsed?.questions || [],
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to generate test.' });
  }
});

// ==========================================
// 4. STUDENT TEST EVALUATION (OBJECTIVE + SUBJECTIVE RUBRICS + REVISION TOPICS)
// ==========================================
// @route   POST /api/student/tests/submit-comprehensive
// @desc    Submit test answers (evaluates objective + short answers with RAG, computes strengths/weaknesses & revision recommendations)
router.post('/tests/submit-comprehensive', async (req, res) => {
  try {
    const {
      testId,
      subject,
      topic,
      difficulty = 'Medium',
      questionTypeFilter = 'Mixed',
      sourceMaterialTitle = '',
      questions,
      userAnswers = {},
      timeTakenSeconds = 0,
    } = req.body;

    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'Invalid test submission.' });
    }

    let totalScore = 0;
    let totalMaxPoints = 0;

    // Evaluate each question
    const evaluatedQuestions = [];
    const subjectiveEvaluationsNeeded = [];

    for (let idx = 0; idx < questions.length; idx++) {
      const q = questions[idx];
      const maxPts = Number(q.points) || 1;
      totalMaxPoints += maxPts;

      const submission = userAnswers[idx];
      const qType = q.questionType || 'MCQ';

      if (qType === 'MCQ' || qType === 'TrueFalse') {
        // Deterministic matching
        const selectedOpt = typeof submission === 'number' ? submission : parseInt(submission, 10);
        const isCorrect = selectedOpt === q.correctAnswerIndex;
        const awarded = isCorrect ? maxPts : 0;
        totalScore += awarded;

        evaluatedQuestions.push({
          questionId: q.questionId,
          questionType: qType,
          question: q.question,
          options: q.options || [],
          correctAnswerIndex: q.correctAnswerIndex,
          correctTextAnswer: q.options?.[q.correctAnswerIndex] || q.correctTextAnswer || '',
          userSelectedOption: selectedOpt,
          userTextAnswer: q.options?.[selectedOpt] || '',
          isCorrect,
          points: maxPts,
          awardedPoints: awarded,
          explanation: q.explanation,
          rubricFeedback: isCorrect ? 'Correct selection.' : `Incorrect. Expected ${q.options?.[q.correctAnswerIndex]}`,
          topicTag: q.topicTag || topic,
        });
      } else if (qType === 'FillBlank') {
        // Deterministic text matching
        const userText = (typeof submission === 'string' ? submission : '').trim().toLowerCase();
        const correctText = (q.correctTextAnswer || '').trim().toLowerCase();
        const isCorrect = userText.length > 0 && (userText === correctText || correctText.includes(userText));
        const awarded = isCorrect ? maxPts : 0;
        totalScore += awarded;

        evaluatedQuestions.push({
          questionId: q.questionId,
          questionType: qType,
          question: q.question,
          options: [],
          correctAnswerIndex: 0,
          correctTextAnswer: q.correctTextAnswer,
          userSelectedOption: null,
          userTextAnswer: typeof submission === 'string' ? submission : '',
          isCorrect,
          points: maxPts,
          awardedPoints: awarded,
          explanation: q.explanation,
          rubricFeedback: isCorrect ? 'Exact keyword match!' : `Expected: "${q.correctTextAnswer}"`,
          topicTag: q.topicTag || topic,
        });
      } else {
        // Subjective (ShortAnswer / Descriptive)
        subjectiveEvaluationsNeeded.push({
          index: idx,
          question: q.question,
          studentAnswer: typeof submission === 'string' ? submission : '',
          modelAnswer: q.correctTextAnswer || q.explanation,
          maxPoints: maxPts,
          topicTag: q.topicTag || topic,
        });
      }
    }

    // If there are subjective short answers, evaluate them using Groq + RAG
    if (subjectiveEvaluationsNeeded.length > 0) {
      const subjectivePrompt = `You are an AI Examination Evaluator grading student short-answer responses.
Subject: ${subject}
Topic: ${topic}

QUESTIONS AND STUDENT SUBMISSIONS TO EVALUATE:
${JSON.stringify(subjectiveEvaluationsNeeded, null, 2)}

Instructions:
Evaluate each short-answer based on conceptual accuracy, key terms, and logical completeness against the model answer.
Award points (0 to maxPoints), determine isCorrect (awarded >= 60% of maxPoints), and provide constructive feedback.
Return ONLY valid JSON matching:
{
  "evaluatedSubjectives": [
    {
      "index": 0,
      "awardedPoints": 3,
      "isCorrect": true,
      "rubricFeedback": "Good reasoning on core invariants.",
      "improvementTip": "Mention boundary conditions."
    }
  ]
}`;

      const evalCompletion = await generateChatCompletion({
        messages: [
          { role: 'system', content: 'You are an academic evaluator. Output JSON.' },
          { role: 'user', content: subjectivePrompt },
        ],
        response_format: { type: 'json_object' },
      });

      let parsedSubj;
      try {
        parsedSubj = JSON.parse(evalCompletion);
      } catch (err) {
        const match = evalCompletion.match(/\{[\s\S]*\}/);
        parsedSubj = match ? JSON.parse(match[0]) : { evaluatedSubjectives: [] };
      }

      const subjMap = {};
      (parsedSubj?.evaluatedSubjectives || []).forEach((item) => {
        subjMap[item.index] = item;
      });

      subjectiveEvaluationsNeeded.forEach((item) => {
        const result = subjMap[item.index] || {
          awardedPoints: Math.round(item.maxPoints * 0.7),
          isCorrect: true,
          rubricFeedback: 'Reasonable conceptual response.',
        };

        totalScore += Number(result.awardedPoints || 0);

        evaluatedQuestions.push({
          questionId: questions[item.index].questionId,
          questionType: questions[item.index].questionType || 'ShortAnswer',
          question: item.question,
          options: [],
          correctAnswerIndex: 0,
          correctTextAnswer: item.modelAnswer,
          userSelectedOption: null,
          userTextAnswer: item.studentAnswer,
          isCorrect: result.isCorrect,
          points: item.maxPoints,
          awardedPoints: result.awardedPoints,
          explanation: questions[item.index].explanation,
          rubricFeedback: result.rubricFeedback,
          topicTag: item.topicTag,
        });
      });
    }

    // Sort evaluated questions back into original index order
    evaluatedQuestions.sort((a, b) => {
      const idxA = questions.findIndex((q) => q.question === a.question);
      const idxB = questions.findIndex((q) => q.question === b.question);
      return idxA - idxB;
    });

    const percentage = Math.round((totalScore / (totalMaxPoints || 1)) * 100);

    // Identify weak areas and strengths
    const missedTopics = evaluatedQuestions.filter((q) => !q.isCorrect).map((q) => q.topicTag);
    const correctTopics = evaluatedQuestions.filter((q) => q.isCorrect).map((q) => q.topicTag);
    const weakAreas = Array.from(new Set(missedTopics));
    const strengths = Array.from(new Set(correctTopics));

    // Generate AI Diagnostic feedback & Recommended Topics for Revision
    const diagnosticPrompt = `A student completed a practice test on "${topic}" in "${subject}".
Score: ${totalScore}/${totalMaxPoints} (${percentage}%)
Mastered Subtopics: ${strengths.join(', ') || 'None yet'}
Missed/Weak Subtopics: ${weakAreas.join(', ') || 'None (100% Score!)'}

Instructions:
1. Provide a constructive 2-sentence diagnostic feedback summary.
2. List 2-3 specific "recommendedRevisionTopics" for the student to review next.

Return ONLY valid JSON:
{
  "aiDiagnosticFeedback": "Feedback here",
  "recommendedRevisionTopics": ["Revision Topic 1", "Revision Topic 2"]
}`;

    const diagCompletion = await generateChatCompletion({
      messages: [
        { role: 'system', content: 'You are an academic diagnostics coach. Output JSON.' },
        { role: 'user', content: diagnosticPrompt },
      ],
      response_format: { type: 'json_object' },
    });

    let parsedDiag;
    try {
      parsedDiag = JSON.parse(diagCompletion);
    } catch (err) {
      const match = diagCompletion.match(/\{[\s\S]*\}/);
      parsedDiag = match ? JSON.parse(match[0]) : null;
    }

    let testDoc = null;
    if (testId) {
      testDoc = await Test.findById(testId);
    }

    const isAssigned = !!testDoc;

    const testAttempt = await TestAttempt.create({
      userId: req.user._id,
      testId: isAssigned ? testDoc._id : undefined,
      professorName: isAssigned ? (testDoc.professorName || '') : '',
      courseId: isAssigned ? (testDoc.courseId || '') : '',
      subject,
      topic,
      difficulty,
      questionTypeFilter,
      sourceMaterialTitle: isAssigned ? (testDoc.title || sourceMaterialTitle) : sourceMaterialTitle,
      questions: evaluatedQuestions,
      score: totalScore,
      totalQuestions: questions.length,
      totalMaxPoints,
      percentage,
      weakAreas,
      strengths,
      recommendedRevisionTopics: isAssigned ? [] : (parsedDiag?.recommendedRevisionTopics || weakAreas),
      aiDiagnosticFeedback: isAssigned ? "Awaiting grading and feedback from your professor." : (parsedDiag?.aiDiagnosticFeedback || `Scored ${totalScore}/${totalMaxPoints} (${percentage}%). Review ${weakAreas[0] || 'core concepts'}.`),
      timeTakenSeconds,
      isReleased: !isAssigned,
      completedAt: new Date(),
    });

    if (isAssigned) {
      // Create GradedSubmission for professor review
      const gradedItems = evaluatedQuestions.map((q, idx) => {
        let studentAnsText = 'No Answer';
        if (q.userSelectedOption !== null && q.userSelectedOption !== undefined) {
          studentAnsText = q.options?.[q.userSelectedOption] || String(q.userSelectedOption);
        } else if (q.userTextAnswer) {
          studentAnsText = q.userTextAnswer;
        }
        
        let refAnsText = 'N/A';
        if (q.correctAnswerIndex !== null && q.correctAnswerIndex !== undefined && q.options?.length > 0) {
          refAnsText = q.options[q.correctAnswerIndex];
        } else if (q.correctTextAnswer) {
          refAnsText = q.correctTextAnswer;
        }

        return {
          questionNumber: idx + 1,
          questionType: q.questionType || 'ShortAnswer',
          question: q.question,
          studentAnswer: studentAnsText,
          referenceAnswer: refAnsText,
          maxPoints: q.points || 1,
          awardedPoints: q.awardedPoints || 0,
          originalAwardedPoints: q.awardedPoints || 0,
          isOverridden: false,
          rubricCriterion: ['MCQ', 'TrueFalse', 'FillBlank'].includes(q.questionType) ? 'Objective Correctness' : 'AI Grading Rubric',
          evaluatorNotes: q.rubricFeedback || '',
          improvementTip: q.improvementTip || ''
        };
      });

      await GradedSubmission.create({
        professorId: testDoc.createdBy,
        studentId: req.user._id,
        studentName: req.user.name,
        testId: testDoc._id,
        testAttemptId: testAttempt._id,
        subject: testDoc.subject || subject,
        assignmentTitle: testDoc.title || 'Online Assessment',
        questionPaperText: testDoc.questions?.map((q, idx) => `${idx+1}. [${q.questionType}] ${q.question}`).join('\n') || '',
        submissionText: JSON.stringify(userAnswers),
        sourceExtractionMethod: 'OnlineSubmission',
        gradedItems,
        totalScore,
        maxScore: totalMaxPoints,
        percentage,
        overallGrade: percentage >= 90 ? 'A' : percentage >= 80 ? 'B+' : percentage >= 70 ? 'B' : percentage >= 60 ? 'C' : 'D',
        individualizedFeedback: 'Online exam submitted. Awaiting professor feedback.',
        keyStrengths: strengths,
        areasForGrowth: weakAreas,
        isReleased: false,
      });
    }

    res.status(201).json(testAttempt);
  } catch (error) {
    console.error('[TestSubmitComprehensive] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to evaluate test submission.' });
  }
});

// Standard submit test alias
router.post('/tests/submit', async (req, res) => {
  try {
    const { subject, topic, difficulty, questions, userAnswers, timeTakenSeconds } = req.body;
    let score = 0;
    const evaluated = (questions || []).map((q, idx) => {
      const selected = userAnswers[idx];
      const isCorrect = selected === q.correctAnswerIndex;
      if (isCorrect) score += 1;
      return {
        question: q.question,
        options: q.options,
        correctAnswerIndex: q.correctAnswerIndex,
        userSelectedOption: selected,
        isCorrect,
        explanation: q.explanation,
        topicTag: q.topicTag || topic,
      };
    });

    const total = questions.length || 1;
    const percentage = Math.round((score / total) * 100);

    const missed = evaluated.filter((q) => !q.isCorrect).map((q) => q.topicTag);
    const correct = evaluated.filter((q) => q.isCorrect).map((q) => q.topicTag);

    const attempt = await TestAttempt.create({
      userId: req.user._id,
      subject,
      topic,
      difficulty: difficulty || 'Medium',
      questions: evaluated,
      score,
      totalQuestions: total,
      totalMaxPoints: total,
      percentage,
      weakAreas: Array.from(new Set(missed)),
      strengths: Array.from(new Set(correct)),
      recommendedRevisionTopics: Array.from(new Set(missed)),
      aiDiagnosticFeedback: `Good effort! Scored ${score}/${total} (${percentage}%).`,
      timeTakenSeconds: timeTakenSeconds || 0,
      completedAt: new Date(),
    });

    res.status(201).json(attempt);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to submit test.' });
  }
});

// @route   GET /api/student/tests/history
// @desc    Get practice test history for the logged-in student
router.get('/tests/history', async (req, res) => {
  try {
    const history = await TestAttempt.find({ userId: req.user._id }).sort({ completedAt: -1 });
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch test history.' });
  }
});

// @route   DELETE /api/student/tests/history/:id
// @desc    Delete a single test attempt from student's history
router.delete('/tests/history/:id', async (req, res) => {
  try {
    // Prevent deletion of official professor-assigned exams
    const attempt = await TestAttempt.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!attempt) {
      return res.status(404).json({ error: 'Test record not found or access denied.' });
    }

    if (attempt.testId) {
      return res.status(403).json({ error: 'Official exam attempts cannot be deleted from your records.' });
    }

    await TestAttempt.deleteOne({ _id: req.params.id });
    res.json({ message: 'Test attempt deleted successfully.', id: req.params.id });
  } catch (error) {
    console.error('[TestHistoryDeleteSingle] Error:', error);
    res.status(500).json({ error: 'Failed to delete test attempt.' });
  }
});

// @route   DELETE /api/student/tests/history
// @desc    Reset / Clear all test attempts and diagnostics for the student
router.delete('/tests/history', async (req, res) => {
  try {
    // Only delete self-practice test attempts (where testId is not present)
    const result = await TestAttempt.deleteMany({
      userId: req.user._id,
      testId: { $exists: false },
    });
    res.json({
      message: 'All self-practice test history and diagnostics have been reset successfully.',
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('[TestHistoryResetAll] Error:', error);
    res.status(500).json({ error: 'Failed to reset test history.' });
  }
});

// ==========================================
// 5. DOUBT CLARIFICATION CHAT WITH RAG CITATIONS
// ==========================================
// @route   POST /api/student/doubts
// @desc    Ask a doubt, retrieve syllabus/textbook chunks from student vault, answer with Groq & cite sources
router.post('/doubts', async (req, res) => {
  try {
    const {
      subject,
      subjectCode = '',
      department = 'CSE',
      query,
      selectedDocTitle = '',
    } = req.body;

    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Question or doubt query is required.' });
    }

    // 1. Retrieve subjectCode-scoped RAG chunks (Isolated to student's knowledge vault & course syllabus)
    const relevantChunks = await retrieveRelevantChunks({
      subject: subject || 'All',
      subjectCode: subjectCode || null,
      department: department || null,
      query: `${query} ${subjectCode} ${selectedDocTitle}`,
      topK: 4,
      userId: req.user._id,
      docTitle: selectedDocTitle || null,
    });
    const groundedContext = formatGroundedContext(relevantChunks);

    const prompt = `You are the EduCopilot Academic Assistant helping a student clarify their doubt.
Subject: ${subject || 'General Academic'}
Student Question: "${query}"

RETRIEVED COURSE MATERIAL / SYLLABUS / TEXTBOOK CONTEXT:
${groundedContext}

Instructions:
- Provide a crystal-clear, structured academic explanation grounded strictly in the course material provided.
- Format using clean Markdown only. Use ## Heading for main sections, ### for subheadings, - for bullet points, and **bold text** for important terms and definitions.
- Do NOT output raw HTML tags (e.g. do NOT output <h2>, <h3>, <p>, <ul>, <li>).
- Do NOT include redundant "Core Takeaways" or "Key Takeaways" text inside the "answer" field, as they are provided separately in the keyTakeaways array.
Return ONLY valid JSON matching this structure:
{
  "answer": "Clear formatted answer with ## Section Headings, bullet points, and **bold keywords**.",
  "keyTakeaways": ["Takeaway 1", "Takeaway 2"],
  "suggestedFollowUps": ["Follow-up question 1?", "Follow-up question 2?"]
}`;

    const completion = await generateChatCompletion({
      messages: [
        {
          role: 'system',
          content: 'You are an intelligent academic tutor. Output ONLY JSON.',
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    });

    let parsed;
    try {
      parsed = JSON.parse(completion);
    } catch (err) {
      const jsonMatch = completion.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch (e) {
          parsed = null;
        }
      }
    }

    const formatToCleanMarkdown = (val, depth = 3) => {
      if (val === null || val === undefined) return '';
      if (typeof val === 'string') return val.trim();
      if (typeof val === 'number' || typeof val === 'boolean') return String(val);
      if (Array.isArray(val)) {
        return val.map((item) => `- ${formatToCleanMarkdown(item, depth + 1)}`).join('\n');
      }
      if (typeof val === 'object') {
        const hashes = '#'.repeat(Math.min(depth, 4));
        return Object.entries(val)
          .map(([k, v]) => `${hashes} ${k}\n${formatToCleanMarkdown(v, depth + 1)}`)
          .join('\n\n');
      }
      return String(val);
    };

    let rawAnswer =
      (parsed && (parsed.answer || parsed.explanation || parsed.response || parsed.clarification || parsed.content || parsed.message || parsed.result)) ||
      (typeof parsed === 'string' && parsed.trim() ? parsed.trim() : '') ||
      (typeof completion === 'string' && completion.trim() ? completion.trim() : '') ||
      'Based on your course materials, here is the verified academic explanation for your doubt.';

    rawAnswer = formatToCleanMarkdown(rawAnswer);

    // Clean any trailing duplicate takeaways header from answer
    const answer = rawAnswer
      .replace(/(?:\r\n|\r|\n)+(?:#{1,4}\s*)?(?:Core|Key)\s*Takeaways[\s\S]*$/i, '')
      .trim();

    const keyTakeaways =
      (parsed && Array.isArray(parsed.keyTakeaways) && parsed.keyTakeaways.length > 0 && parsed.keyTakeaways) ||
      (parsed && Array.isArray(parsed.takeaways) && parsed.takeaways.length > 0 && parsed.takeaways) ||
      [
        'Understand foundational definitions and theorems',
        'Review edge-case state transitions and system invariants',
        'Practice related test questions to test comprehension',
      ];

    const suggestedFollowUps =
      (parsed && Array.isArray(parsed.suggestedFollowUps) && parsed.suggestedFollowUps.length > 0 && parsed.suggestedFollowUps) ||
      (parsed && Array.isArray(parsed.followUps) && parsed.followUps.length > 0 && parsed.followUps) ||
      [
        'How does this concept apply under extreme failure scenarios?',
        'Can you provide a step-by-step example with numbers/code?',
        'What are the primary performance and complexity trade-offs?',
      ];

    const citedSources = relevantChunks.map((c) => ({
      docTitle: c.docTitle,
      subject: c.subject,
      chunkExcerpt: (c.chunkText || '').slice(0, 250) + '...',
      relevanceScore: c.relevanceScore || 0.85,
    }));

    const doubtRecord = await Doubt.create({
      userId: req.user._id,
      subject: subject || 'General',
      query,
      answer,
      citedSources,
      keyTakeaways,
      suggestedFollowUps,
    });

    res.status(201).json(doubtRecord);
  } catch (error) {
    console.error('[DoubtClarification] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to clarify doubt.' });
  }
});

// @route   GET /api/student/doubts/history
// @desc    Get doubt clarification history for the logged-in student
router.get('/doubts/history', async (req, res) => {
  try {
    const doubts = await Doubt.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(doubts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch doubt history.' });
  }
});

// @route   DELETE /api/student/doubts/history/:id
// @desc    Delete a single doubt record for the logged-in student
router.delete('/doubts/history/:id', async (req, res) => {
  try {
    const deleted = await Doubt.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!deleted) {
      return res.status(404).json({ error: 'Doubt record not found or access denied.' });
    }

    res.json({ message: 'Doubt question deleted successfully.', id: req.params.id });
  } catch (error) {
    console.error('[DoubtDeleteSingle] Error:', error);
    res.status(500).json({ error: 'Failed to delete doubt question.' });
  }
});

// @route   DELETE /api/student/doubts/history
// @desc    Reset / Clear all doubt history for the logged-in student
router.delete('/doubts/history', async (req, res) => {
  try {
    const result = await Doubt.deleteMany({ userId: req.user._id });
    res.json({
      message: 'All doubt questions have been cleared successfully.',
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('[DoubtResetAll] Error:', error);
    res.status(500).json({ error: 'Failed to clear doubt history.' });
  }
});

// ==========================================
// 6. STUDENT READ-ONLY SUBJECT-SCOPED RAG SEARCH
// ==========================================
// @route   POST /api/student/rag/search
// @desc    Read-only course material RAG search & answer scoped by subjectCode
// @access  Protected (Student only)
router.post('/rag/search', async (req, res) => {
  try {
    const { subjectCode, query, subject, department = 'CSE', topK = 4 } = req.body;

    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Search query is required.' });
    }

    // Retrieve relevant chunks filtered strictly by subjectCode
    const relevantChunks = await retrieveRelevantChunks({
      subjectCode: subjectCode || null,
      department: department || null,
      subject: subject || 'All',
      query: query.trim(),
      topK: Number(topK) || 4,
      userId: req.user._id,
    });

    const groundedContext = formatGroundedContext(relevantChunks);

    const prompt = `You are the EduCopilot Academic Assistant providing answers grounded strictly in the course material for ${subjectCode || subject || 'the course'}.
Student Query: "${query}"

RETRIEVED COURSE MATERIAL & SYLLABUS CONTEXT:
${groundedContext}

Instructions:
- Provide a clear, intuitive, and structured academic answer grounded strictly in the retrieved course chunks.
- Format using clean Markdown only. Use ## Heading for sections, - for bullet points, and **bold text** for important definitions. Do NOT output raw HTML tags.
- Return ONLY valid JSON matching this exact structure:
{
  "answer": "Clear markdown answer with ## Section Headings and bullet points.",
  "keyTakeaways": ["Key point 1", "Key point 2"],
  "suggestedFollowUps": ["Related concept question 1?", "Related concept question 2?"]
}`;

    const completion = await generateChatCompletion({
      messages: [
        { role: 'system', content: 'You are an academic tutor. Output ONLY JSON.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    });

    let parsed;
    try {
      parsed = JSON.parse(completion);
    } catch (err) {
      const match = completion.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }

    res.json({
      query,
      subjectCode: subjectCode || '',
      subject: subject || '',
      department: department || 'CSE',
      answer: parsed?.answer || completion,
      keyTakeaways: parsed?.keyTakeaways || [],
      suggestedFollowUps: parsed?.suggestedFollowUps || [],
      relevantChunks,
    });
  } catch (error) {
    console.error('[StudentRAGSearch] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to perform course RAG search.' });
  }
});

module.exports = router;
