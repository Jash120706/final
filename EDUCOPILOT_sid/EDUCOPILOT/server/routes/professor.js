const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protect, authorize } = require('../middleware/authMiddleware');
const LectureSchedule = require('../models/LectureSchedule');
const LecturePlan = require('../models/LecturePlan');
const Material = require('../models/Material');
const GradedSubmission = require('../models/GradedSubmission');
const CourseDocChunk = require('../models/CourseDocChunk');
const Test = require('../models/Test');
const { generateChatCompletion } = require('../services/groqService');
const { retrieveRelevantChunks, formatGroundedContext, ingestDocument } = require('../services/ragService');
const { extractTextFromFile } = require('../services/fileParserService');

// Multer memory storage for multi-modal uploads (PDF, Excel, Images, Text)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB limit
});

// Protect all professor routes
router.use(protect);
router.use(authorize('professor'));

// ==========================================
// 1. PROFESSOR DASHBOARD
// ==========================================
router.get('/dashboard', async (req, res) => {
  try {
    const profId = req.user._id;

    const [schedules, materials, gradings, docCount] = await Promise.all([
      LecturePlan.find({ professorId: profId }).sort({ createdAt: -1 }).limit(5),
      Material.find({ professorId: profId }).sort({ createdAt: -1 }).limit(5),
      GradedSubmission.find({ professorId: profId }).sort({ gradedAt: -1 }).limit(5),
      CourseDocChunk.countDocuments({ uploadedBy: profId }),
    ]);

    const totalSchedules = await LecturePlan.countDocuments({ professorId: profId });
    const totalMaterials = await Material.countDocuments({ professorId: profId });
    const totalGradings = await GradedSubmission.countDocuments({ professorId: profId });

    res.json({
      stats: {
        totalSchedules,
        totalMaterials,
        totalGradings,
        indexedDocsChunks: docCount,
      },
      upcomingLectures: schedules,
      recentSchedules: schedules,
      recentMaterials: materials,
      recentGradings: gradings,
    });
  } catch (error) {
    console.error('[ProfessorDashboard] Error:', error);
    res.status(500).json({ error: 'Failed to load professor dashboard.' });
  }
});

// ==========================================
// 2. LECTURE SCHEDULING (MULTI-MODAL IMPORT + STAGING + EDITING)
// ==========================================
// @route   POST /api/professor/schedules/import
// @desc    Import schedule from PDF, Excel/CSV, Timetable Image, or Raw text -> extracts structured lectures for staging
router.post('/schedules/import', upload.single('file'), async (req, res) => {
  try {
    const { rawText, defaultSubject = 'Computer Science', defaultCourseCode = 'CS-301' } = req.body;
    let extractedText = rawText || '';

    if (req.file) {
      extractedText = await extractTextFromFile({
        fileBuffer: req.file.buffer,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
      });
    }

    if (!extractedText || extractedText.trim().length < 5) {
      return res.status(400).json({
        error: 'Please upload a PDF/Excel/Image timetable file or paste text content to import.',
      });
    }

    const prompt = `You are an AI Academic Timetable & Syllabus Extraction Engine.
Extract all lecture sessions, classes, topics, dates, times, durations, and sections from the provided document.

DOCUMENT CONTENT:
"""
${extractedText.slice(0, 8000)}
"""

Instructions:
Extract each lecture row accurately. If date or time is not explicitly stated, generate a reasonable sequential date starting from upcoming Monday and standard 60-min time slots.
Return ONLY valid JSON matching this exact structure:
{
  "extractedLectures": [
    {
      "courseCode": "${defaultCourseCode}",
      "subject": "${defaultSubject}",
      "title": "Topic or Lecture Title",
      "date": "YYYY-MM-DD",
      "time": "10:00 AM",
      "durationMinutes": 60,
      "classOrSection": "Section A",
      "topics": ["Subtopic 1", "Subtopic 2"],
      "learningObjectives": ["Learning Objective 1"],
      "aiSequencingNotes": "Sequential placement rationale"
    }
  ]
}`;

    const completion = await generateChatCompletion({
      messages: [
        { role: 'system', content: 'You are a timetable extraction engine. Output strictly JSON.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    });

    let parsed;
    try {
      parsed = JSON.parse(completion);
    } catch (err) {
      const match = completion.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { extractedLectures: [] };
    }

    const lectures = parsed?.extractedLectures || [];
    res.json({
      totalExtracted: lectures.length,
      extractedLectures: lectures,
      sourceExcerpt: extractedText.slice(0, 300) + '...',
    });
  } catch (error) {
    console.error('[ScheduleImport] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to import timetable.' });
  }
});

// @route   POST /api/professor/schedules/batch
// @desc    Batch save edited extracted lectures to calendar
router.post('/schedules/batch', async (req, res) => {
  try {
    const { lectures } = req.body;
    if (!lectures || !Array.isArray(lectures) || lectures.length === 0) {
      return res.status(400).json({ error: 'No lectures provided to save.' });
    }

    const docsToInsert = lectures.map((lec) => ({
      professorId: req.user._id,
      courseCode: lec.courseCode || 'CS-301',
      subject: lec.subject || 'Computer Science',
      title: lec.title || 'Untitled Lecture',
      date: lec.date || new Date().toISOString().split('T')[0],
      time: lec.time || '10:00 AM',
      classOrSection: lec.classOrSection || 'Section A',
      durationMinutes: Number(lec.durationMinutes) || 60,
      topics: Array.isArray(lec.topics) ? lec.topics : [lec.topics || 'General'],
      learningObjectives: Array.isArray(lec.learningObjectives) ? lec.learningObjectives : [],
      aiSequencingNotes: lec.aiSequencingNotes || '',
      status: 'Scheduled',
    }));

    const inserted = await LectureSchedule.insertMany(docsToInsert);
    res.status(201).json({
      message: `Successfully saved ${inserted.length} lectures to your schedule.`,
      schedules: inserted,
    });
  } catch (error) {
    console.error('[ScheduleBatchSave] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to save lectures to schedule.' });
  }
});

// @route   POST /api/professor/schedules/generate
// @desc    Generate AI-assisted slot-by-slot prerequisite plan from Syllabus text or PDF upload and save to MongoDB
router.post('/schedules/generate', upload.single('file'), async (req, res) => {
  try {
    let {
      subject,
      courseCode,
      syllabus = '',
      topicsList = '',
      numPeriods = 5,
      minutesPerPeriod = 60,
      deadline = '',
      selectedDocTitle = '',
    } = req.body;

    let finalSyllabus = syllabus || topicsList || '';

    // If knowledge base document is selected, fetch chunks and concatenate
    if (selectedDocTitle) {
      const chunks = await CourseDocChunk.find({
        uploadedBy: req.user._id,
        docTitle: selectedDocTitle,
      }).sort({ chunkIndex: 1 });

      if (chunks.length > 0) {
        finalSyllabus = chunks.map((c) => c.chunkText).join('\n\n');
        if (!subject && chunks[0].subject) {
          subject = chunks[0].subject;
        }
        if (!courseCode && (chunks[0].subjectCode || chunks[0].courseCode)) {
          courseCode = chunks[0].subjectCode || chunks[0].courseCode;
        }
      }
    }

    // If PDF or document file is uploaded, extract text automatically
    if (req.file) {
      const extracted = await extractTextFromFile({
        fileBuffer: req.file.buffer,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
      });
      if (extracted && extracted.trim().length > 10) {
        finalSyllabus = extracted;
        // Also ingest into professor's RAG knowledge base
        await ingestDocument({
          uploadedBy: req.user._id,
          docTitle: req.file.originalname.replace(/\.[^/.]+$/, ''),
          subject: subject || 'General',
          rawText: extracted,
        });
      }
    }

    if (!subject || (!finalSyllabus && !req.file)) {
      return res.status(400).json({
        error: 'Subject name and syllabus (text or PDF upload) are required.',
      });
    }

    const periodsCount = Number(numPeriods) || 5;
    const duration = Number(minutesPerPeriod) || 60;

    const relevantChunks = await retrieveRelevantChunks({
      subject,
      subjectCode: courseCode || null,
      query: `${subject} ${courseCode} ${finalSyllabus.slice(0, 500)} syllabus lecture sequencing curriculum prerequisites`,
      topK: 4,
      userId: req.user._id,
    });
    const groundedContext = formatGroundedContext(relevantChunks);

    const prompt = `You are a Senior Academic Curriculum Director and Subject Expert. Convert the given syllabus into a detailed, slot-by-slot lecture schedule that respects prerequisite ordering and time allocation.

INPUT:
- Subject: ${subject} (${courseCode || 'Course'})
- Syllabus Text:
"""
${finalSyllabus.slice(0, 3000)}
"""
- Total Periods: ${periodsCount}
- Minutes per Period: ${duration}
- Deadline Target: ${deadline || 'End of Semester'}

COURSE REFERENCE VAULT CONTEXT:
${groundedContext}

CRITICAL QUALITY DIRECTIVES:
1. DO NOT output abstract or generic topic titles like "Overview", "Basic Concepts", "Module 1", or "Introduction".
2. EVERY period MUST have a specific, technical topic title derived from the syllabus (e.g. "Unit I: Waste Generation Rates & Physical-Chemical Composition Analysis").
3. EVERY period MUST list 3-4 granular, highly concrete subtopics featuring mathematical formulations, equations, algorithms, lab procedures, or architectural schematics.
4. Chain prerequisite topics logically so earlier periods establish foundational concepts required by subsequent periods.
5. If the total syllabus content exceeds the allocated period budget, populate the remaining topics in "at_risk_topics" with pacing recommendations.

Return ONLY valid JSON matching this structure:
{
  "plan": [
    {
      "period": 1,
      "type": "lecture",
      "topic": "Specific Technical Topic Title",
      "subtopics": [
        "Granular Subtopic 1 (Formulas/Equations)",
        "Granular Subtopic 2 (Operational Mechanism)",
        "Granular Subtopic 3 (Laboratory / Applied Analysis)"
      ],
      "prerequisites": ["Foundational Concept A"]
    }
  ],
  "at_risk_topics": [],
  "notes": "Comprehensive pacing rationale and prerequisite alignment notes"
}`;

    const completion = await generateChatCompletion({
      messages: [
        { role: 'system', content: 'You are an academic curriculum director. Output strictly JSON.' },
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

    // Extract raw plan slots from any plausible key
    let rawPlan =
      (parsed && (parsed.plan || parsed.sequencedLectures || parsed.schedule || parsed.slots || parsed.lectures)) ||
      [];

    if (!Array.isArray(rawPlan)) {
      rawPlan = [];
    }

    // If fewer slots were generated than requested periods (e.g. 35 periods), synthesize remaining slots
    const syllabusSections = finalSyllabus
      .split(/(?:Unit\s+[IVX0-9]+[:\.\-]|Chapter\s+[0-9]+[:\.\-]|\n+|\.\s+)/i)
      .map(s => s.trim())
      .filter(s => s.length > 3);

    const finalPlan = [];
    for (let p = 1; p <= periodsCount; p++) {
      const existingSlot = rawPlan.find(s => (s.period === p || s.lectureNumber === p)) || rawPlan[p - 1];
      
      if (existingSlot && (existingSlot.topic || existingSlot.title)) {
        finalPlan.push({
          period: p,
          type: existingSlot.type || (p % 7 === 0 ? 'tutorial' : 'lecture'),
          topic: existingSlot.topic || existingSlot.title,
          subtopics: Array.isArray(existingSlot.subtopics) && existingSlot.subtopics.length > 0
            ? existingSlot.subtopics
            : Array.isArray(existingSlot.topics) && existingSlot.topics.length > 0
            ? existingSlot.topics
            : [`Fundamental concepts & definitions for Period ${p}`, `Applied problem solving & case study`],
          prerequisites: Array.isArray(existingSlot.prerequisites)
            ? existingSlot.prerequisites
            : existingSlot.prerequisites
            ? [String(existingSlot.prerequisites)]
            : p > 1
            ? [finalPlan[p - 2]?.topic || `Foundational Module`]
            : [],
          completed: false,
        });
      } else {
        const sectionIdx = syllabusSections.length > 0 ? (p - 1) % syllabusSections.length : 0;
        const sectionName = syllabusSections[sectionIdx] || `${subject} Module ${Math.ceil(p / 5)}`;
        const subIdx = ((p - 1) % 4) + 1;

        finalPlan.push({
          period: p,
          type: p % 7 === 0 ? 'tutorial' : 'lecture',
          topic: p === 1 
            ? `Introduction & Foundational Invariants of ${sectionName}` 
            : p === periodsCount 
            ? `Synthesis, Diagnostic Review & High-Yield Exam Problems`
            : `${sectionName} (Part ${subIdx}): In-depth Mechanisms & Analysis`,
          subtopics: [
            `Core mathematical / architectural principles of ${sectionName}`,
            `State transitions, constraint boundaries & design criteria`,
            `Applied laboratory / problem formulation walkthrough`
          ],
          prerequisites: p > 1 ? [finalPlan[p - 2]?.topic || `Previous Period Fundamentals`] : [],
          completed: false,
        });
      }
    }

    // Save the complete generated plan to MongoDB LecturePlan collection
    const createdPlan = await LecturePlan.create({
      professorId: req.user._id,
      subject,
      courseCode: courseCode || 'ENV-401',
      title: `${subject} (${courseCode || 'Course'}) Lecture Plan`,
      syllabus: finalSyllabus.slice(0, 3000),
      numPeriods: periodsCount,
      minutesPerPeriod: duration,
      deadline: deadline || '',
      plan: finalPlan,
      at_risk_topics: (parsed && parsed.at_risk_topics) || [],
      notes: (parsed && parsed.notes) || `Full ${periodsCount}-period slot plan organized in strict prerequisite dependency order.`,
      status: 'Active',
    });

    res.status(201).json(createdPlan);
  } catch (error) {
    console.error('[ScheduleGenerate] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate lecture schedule.' });
  }
});

// @route   POST /api/professor/schedules/suggest
// @desc    Alias for schedule generation
router.post('/schedules/suggest', upload.single('file'), async (req, res) => {
  try {
    let {
      subject,
      courseCode,
      syllabus = '',
      topicsList = '',
      numPeriods = 5,
      minutesPerPeriod = 60,
      deadline = '',
      selectedDocTitle = '',
    } = req.body;

    let finalSyllabus = syllabus || topicsList || '';

    // If knowledge base document is selected, fetch chunks and concatenate
    if (selectedDocTitle) {
      const chunks = await CourseDocChunk.find({
        uploadedBy: req.user._id,
        docTitle: selectedDocTitle,
      }).sort({ chunkIndex: 1 });

      if (chunks.length > 0) {
        finalSyllabus = chunks.map((c) => c.chunkText).join('\n\n');
        if (!subject && chunks[0].subject) {
          subject = chunks[0].subject;
        }
        if (!courseCode && (chunks[0].subjectCode || chunks[0].courseCode)) {
          courseCode = chunks[0].subjectCode || chunks[0].courseCode;
        }
      }
    }

    if (req.file) {
      const extracted = await extractTextFromFile({
        fileBuffer: req.file.buffer,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
      });
      if (extracted && extracted.trim().length > 10) {
        finalSyllabus = extracted;
      }
    }

    if (!subject || !finalSyllabus) {
      return res.status(400).json({ error: 'Subject and syllabus/topic list are required.' });
    }

    const periodsCount = Number(numPeriods) || 5;
    const duration = Number(minutesPerPeriod) || 60;

    const relevantChunks = await retrieveRelevantChunks({
      subject,
      subjectCode: courseCode || null,
      query: `${finalSyllabus.slice(0, 300)} syllabus lecture sequencing curriculum prerequisites`,
      topK: 3,
      userId: req.user._id,
    });
    const groundedContext = formatGroundedContext(relevantChunks);

    const prompt = `You are a lecture-scheduling assistant. Convert the given syllabus into a slot-by-slot plan that respects topic prerequisites and fits the time given.

INPUT:
- Subject: ${subject} (${courseCode || 'Course'})
- Syllabus: ${finalSyllabus.slice(0, 5000)}
- Number of periods: ${periodsCount}
- Minutes per period: ${duration}
- Deadline: ${deadline || 'End of Semester'}

COURSE REFERENCE CONTEXT:
${groundedContext}

TASK:
1. Split syllabus into topics/sub-topics, identify prerequisite order.
2. Estimate periods needed per topic based on complexity.
3. Assign topics to periods in dependency order, filling all periods.
4. If topics don't fit, flag them in at_risk_topics instead of dropping silently.
5. Output ONLY this JSON (no extra text):

{
  "plan": [
    {
      "period": 1,
      "type": "lecture",
      "topic": "Topic Title",
      "subtopics": ["Subtopic 1", "Subtopic 2"],
      "prerequisites": ["Prereq 1"]
    }
  ],
  "at_risk_topics": [],
  "notes": "Syllabus pacing and prerequisite alignment notes"
}`;

    const completion = await generateChatCompletion({
      messages: [
        { role: 'system', content: 'You are an academic curriculum director. Output strictly JSON.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    });

    let parsed;
    try {
      parsed = JSON.parse(completion);
    } catch (err) {
      const jsonMatch = completion.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { plan: [], at_risk_topics: [], notes: '' };
    }

    // Save to LecturePlan
    const createdPlan = await LecturePlan.create({
      professorId: req.user._id,
      subject,
      courseCode: courseCode || 'ENV-401',
      title: `${subject} (${courseCode || 'Course'}) Slot Plan`,
      syllabus: finalSyllabus.slice(0, 3000),
      numPeriods: periodsCount,
      minutesPerPeriod: duration,
      deadline: deadline || '',
      plan: parsed.plan || [],
      at_risk_topics: parsed.at_risk_topics || [],
      notes: parsed.notes || '',
      status: 'Active',
    });

    res.json(createdPlan);
  } catch (error) {
    console.error('[ScheduleSuggest] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to suggest sequencing.' });
  }
});

// @route   GET /api/professor/schedules
// @desc    Get all saved lecture plans for this professor
router.get('/schedules', async (req, res) => {
  try {
    const plans = await LecturePlan.find({ professorId: req.user._id }).sort({ createdAt: -1 });
    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch lecture plans.' });
  }
});

// @route   GET /api/professor/schedules/:id
// @desc    Get single lecture plan by ID
router.get('/schedules/:id', async (req, res) => {
  try {
    const plan = await LecturePlan.findOne({ _id: req.params.id, professorId: req.user._id });
    if (!plan) return res.status(404).json({ error: 'Lecture plan not found.' });
    res.json(plan);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch lecture plan.' });
  }
});

// @route   DELETE /api/professor/schedules/:id
// @desc    Delete a lecture plan
router.delete('/schedules/:id', async (req, res) => {
  try {
    const deleted = await LecturePlan.findOneAndDelete({
      _id: req.params.id,
      professorId: req.user._id,
    });
    if (!deleted) {
      // Fallback check legacy LectureSchedule
      await LectureSchedule.findOneAndDelete({
        _id: req.params.id,
        professorId: req.user._id,
      });
    }
    res.json({ message: 'Lecture plan removed successfully.', id: req.params.id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete lecture plan.' });
  }
});

// ==========================================
// 3. AI MATERIAL PREPARATION (SLIDES, NOTES, ASSIGNMENTS, PRACTICE QUESTIONS)
// ==========================================
// @route   POST /api/professor/materials/generate-with-upload
// @desc    Upload direct document OR use RAG vault to synthesize grounded slides, notes, assignments, or practice questions
router.post('/materials/generate-with-upload', upload.single('file'), async (req, res) => {
  try {
    const {
      subject,
      topic,
      type,
      subjectCode = '',
      courseCode = '',
      department = 'CSE',
      syllabusRef = '',
      rawText = '',
      questionCount = 4,
      pointsPerQuestion = 25,
      slideCount = 5,
    } = req.body;

    if (!subject || !topic || !type) {
      return res.status(400).json({ error: 'Subject, topic, and material type are required.' });
    }

    let uploadedDocText = rawText || '';

    // If user provided a new file right in the Material Prep form, ingest it into RAG
    if (req.file) {
      uploadedDocText = await extractTextFromFile({
        fileBuffer: req.file.buffer,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
      });

      if (uploadedDocText && uploadedDocText.trim().length > 20) {
        await ingestDocument({
          uploadedBy: req.user._id,
          docTitle: req.file.originalname.replace(/\.[^/.]+$/, ''),
          subject,
          subjectCode: subjectCode || courseCode || '',
          department: department || 'CSE',
          type: type === 'slides' ? 'content' : 'notes',
          rawText: uploadedDocText,
        });
      }
    }

    // Retrieve relevant chunks from professor's vault filtered by subjectCode
    const relevantChunks = await retrieveRelevantChunks({
      subject,
      subjectCode: subjectCode || courseCode || null,
      query: `${subject} ${topic} ${syllabusRef} ${uploadedDocText.slice(0, 300)}`,
      topK: 8,
      userId: req.user._id,
    });

    let groundedContext = formatGroundedContext(relevantChunks);
    if (uploadedDocText && uploadedDocText.trim().length > 20) {
      groundedContext = `[DIRECTLY ATTACHED STUDY MATERIAL]\n${uploadedDocText.slice(0, 8000)}\n\n` + groundedContext;
    }

    let systemPrompt = 'You are a Senior Academic Author and University Professor. Ground all generated teaching materials strictly in the course content provided. Produce deep, rigorous, non-abstract academic output. Output strictly JSON.';
    let userPrompt = '';

    if (type === 'slides') {
      const sCount = Number(slideCount) || 5;
      userPrompt = `Create an in-depth, professional ${sCount}-slide lecture deck outline on "${topic}" for ${subject}.
COURSE REFERENCE VAULT CONTEXT:
${groundedContext}

QUALITY DIRECTIVES:
1. Each slide MUST contain 3-5 dense, technical bullet points specifying exact operational steps, equations, architectural properties, or design trade-offs. Avoid generic summaries.
2. "visualSuggestion": Describe a specific, concrete diagram, flowchart, graph, or circuit schematic for the slide.
3. "speakerNotes": Provide 3-4 detailed sentences of delivery notes for the professor explaining how to teach the slide concepts, common student traps, and board work equations.

Return JSON matching:
{
  "title": "Presentation Title: ${topic}",
  "slides": [
    {
      "slideNumber": 1,
      "title": "Granular Slide Title",
      "bullets": [
        "Dense technical bullet with specific parameters / formulas",
        "Step-by-step mechanism details",
        "Design trade-off or boundary condition"
      ],
      "visualSuggestion": "Flowchart showing 3-stage process with state transitions",
      "speakerNotes": "Detailed instructor guidance on board work, key student traps, and delivery strategy."
    }
  ]
}`;
    } else if (type === 'notes') {
      userPrompt = `Draft comprehensive, textbook-quality Markdown lecture notes on "${topic}" for ${subject}.
COURSE REFERENCE VAULT CONTEXT:
${groundedContext}

QUALITY DIRECTIVES:
Produce an extensive, highly structured Markdown guide (800-1200+ words) formatted with:
1. **Executive Overview & Core Definitions**: Formal terminology and domain axioms.
2. **Theoretical Principles & Monotonic Invariants**: Mathematical equations, algorithms, and key theorems.
3. **Architectural Schematics / Code Walkthrough**: Concrete structural breakdown or code snippet.
4. **Step-by-Step Worked Example / Case Study**: Numerical or procedural problem walkthrough with step-by-step solutions.
5. **Comparative Trade-offs Table**: Markdown table analyzing performance / design trade-offs.
6. **Common Pitfalls & Exam Traps**: Critical mistakes students make on exams and how to avoid them.

Return JSON matching:
{
  "title": "Comprehensive Lecture Notes: ${topic}",
  "lectureNotes": "Complete Markdown formatted lecture notes text following all 6 required sections above."
}`;
    } else if (type === 'assignment') {
      const qCount = Number(questionCount) || 4;
      const pts = Number(pointsPerQuestion) || 25;
      userPrompt = `Create a rigorous academic assignment with exactly ${qCount} descriptive/analytical questions on "${topic}" for ${subject}.
Each question must be allocated exactly ${pts} points (Total assignment points: ${qCount * pts}).
COURSE REFERENCE VAULT CONTEXT:
${groundedContext}

QUALITY DIRECTIVES:
1. Each question must challenge students with realistic scenarios, quantitative derivations, or architectural design decisions.
2. "rubric": Provide a detailed point-by-point evaluation key specifying exact concepts and steps required for full credit.

Return JSON matching:
{
  "title": "Assignment: ${topic}",
  "instructions": "Submission instructions and academic integrity guidelines",
  "totalPoints": ${qCount * pts},
  "assignments": [
    {
      "question": "Rigorous descriptive or analytical question statement",
      "questionType": "Descriptive",
      "rubric": "Itemized grading rubric: 10 pts for equation derivation, 10 pts for trade-off matrix, 5 pts for edge case analysis",
      "points": ${pts}
    }
  ]
}`;
    } else {
      // practice_questions
      const qCount = Number(questionCount) || 5;
      const pts = Number(pointsPerQuestion) || 10;
      userPrompt = `Create a formative practice question bank with exactly ${qCount} questions and model solutions on "${topic}" for ${subject}.
Each question is worth ${pts} points.
COURSE REFERENCE VAULT CONTEXT:
${groundedContext}

QUALITY DIRECTIVES:
1. Provide a mix of numerical, conceptual, and procedural questions.
2. "modelAnswer": Provide a thorough, multi-step model solution explaining the exact solution logic.

Return JSON matching:
{
  "title": "Practice Question Bank: ${topic}",
  "practiceQuestions": [
    {
      "question": "Clear practice question statement?",
      "questionType": "ShortAnswer",
      "modelAnswer": "Comprehensive multi-step model solution with full reasoning",
      "difficulty": "Medium",
      "points": ${pts}
    }
  ]
}`;
    }

    const completion = await generateChatCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    });

    let parsed;
    try {
      parsed = JSON.parse(completion);
    } catch (err) {
      const jsonMatch = completion.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { content: completion };
    }

    const materialDoc = await Material.create({
      professorId: req.user._id,
      subject,
      topic,
      type,
      title: parsed.title || `${type.toUpperCase()}: ${topic}`,
      content: parsed,
      syllabusRef,
    });

    res.status(201).json(materialDoc);
  } catch (error) {
    console.error('[MaterialGenerate] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate material.' });
  }
});

// @route   GET /api/professor/materials
// @desc    Get all materials created by this professor
router.get('/materials', async (req, res) => {
  try {
    const materials = await Material.find({ professorId: req.user._id }).sort({ createdAt: -1 });
    res.json(materials);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch materials.' });
  }
});

// @route   DELETE /api/professor/materials/:id
// @desc    Delete a material document from the Prepared Material Vault
router.delete('/materials/:id', async (req, res) => {
  try {
    const deleted = await Material.findOneAndDelete({
      _id: req.params.id,
      professorId: req.user._id,
    });
    if (!deleted) {
      return res.status(404).json({ error: 'Material not found or access denied.' });
    }
    res.json({ message: 'Material deleted successfully.', id: req.params.id });
  } catch (error) {
    console.error('[MaterialDelete] Error:', error);
    res.status(500).json({ error: 'Failed to delete material.' });
  }
});

// ==========================================
// 4. ASSESSMENT & AUTO-GRADING (MULTI-FORMAT, OBJECTIVE + SUBJECTIVE, OVERRIDE)
// ==========================================
// @route   POST /api/professor/grading/extract-and-grade
// @desc    Evaluate student submission (supports Question Paper + Answer Sheet upload, OCR, mixed question types)
router.post(
  '/grading/extract-and-grade',
  upload.fields([
    { name: 'questionPaper', maxCount: 1 },
    { name: 'answerSheet', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        studentName,
        subject,
        assignmentTitle,
        questionPaperText = '',
        submissionText = '',
        rubricCriteria = '',
      } = req.body;

      if (!studentName || !assignmentTitle) {
        return res.status(400).json({
          error: 'Student name and assignment title are required.',
        });
      }

      let finalQPText = questionPaperText || '';
      let finalAnswerText = submissionText || '';
      let extractionMethod = 'OnlineSubmission';

      // Extract Question Paper file if provided
      if (req.files?.questionPaper?.[0]) {
        const qpFile = req.files.questionPaper[0];
        finalQPText = await extractTextFromFile({
          fileBuffer: qpFile.buffer,
          originalName: qpFile.originalname,
          mimeType: qpFile.mimetype,
        });
      }

      // Extract Answer Sheet file if provided
      if (req.files?.answerSheet?.[0]) {
        const ansFile = req.files.answerSheet[0];
        extractionMethod = ansFile.mimetype.includes('image')
          ? 'UploadedSheetOCR'
          : 'PDFExtract';
        finalAnswerText = await extractTextFromFile({
          fileBuffer: ansFile.buffer,
          originalName: ansFile.originalname,
          mimeType: ansFile.mimetype,
        });
      }

      if (!finalAnswerText || finalAnswerText.trim().length < 5) {
        return res.status(400).json({
          error: 'Student answer content is empty. Please upload an answer sheet or paste answer text.',
        });
      }

      // Retrieve course reference benchmarks from professor vault
      const relevantChunks = await retrieveRelevantChunks({
        subject: subject || 'General',
        query: `${assignmentTitle} ${finalQPText.slice(0, 200)} ${finalAnswerText.slice(0, 200)}`,
        topK: 3,
        userId: req.user._id,
      });
      const groundedContext = formatGroundedContext(relevantChunks);

      const prompt = `You are an Academic Auto-Grading & Assessment AI.
Evaluate this student's submission against the question paper and grading rubric.

QUESTION PAPER / RUBRIC BENCHMARK:
${finalQPText ? `QUESTION PAPER:\n"""${finalQPText.slice(0, 3000)}"""\n` : ''}
${rubricCriteria ? `RUBRIC GUIDELINES:\n${rubricCriteria}\n` : ''}
COURSE REFERENCE BENCHMARK:
${groundedContext}

STUDENT ANSWER SHEET / SUBMISSION:
"""
${finalAnswerText.slice(0, 5000)}
"""

Instructions:
1. Handle mixed question types:
   - MCQ / True-False / Fill-in-the-blank: evaluate with exact deterministic correctness.
   - Short-Answer / Descriptive: evaluate conceptual depth, reasoning, and technical terms against reference answers.
2. For each question, extract/identify the question number, question type, student's answer, reference answer, max points, and awarded points.
3. Formulate individualized, constructive feedback tailored specifically to ${studentName}'s actual answers (never generic).
4. Provide list of key strengths and areas for growth.

Return ONLY valid JSON matching this exact structure:
{
  "totalScore": 85,
  "maxScore": 100,
  "percentage": 85,
  "overallGrade": "B+",
  "individualizedFeedback": "Constructive 3-4 sentence paragraph addressing ${studentName} directly.",
  "keyStrengths": ["Strength 1", "Strength 2"],
  "areasForGrowth": ["Improvement tip 1", "Improvement tip 2"],
  "gradedItems": [
    {
      "questionNumber": 1,
      "questionType": "MCQ",
      "question": "Question text",
      "studentAnswer": "Student's answer",
      "referenceAnswer": "Expected correct answer",
      "maxPoints": 20,
      "awardedPoints": 20,
      "rubricCriterion": "Objective accuracy",
      "evaluatorNotes": "Correct option selected.",
      "improvementTip": ""
    },
    {
      "questionNumber": 2,
      "questionType": "Descriptive",
      "question": "Question text",
      "studentAnswer": "Student's explanation",
      "referenceAnswer": "Key theoretical points expected",
      "maxPoints": 30,
      "awardedPoints": 25,
      "rubricCriterion": "Conceptual clarity & edge cases",
      "evaluatorNotes": "Well argued; minor omission on boundary conditions.",
      "improvementTip": "Include formal proofs for edge cases."
    }
  ]
}`;

      const completion = await generateChatCompletion({
        messages: [
          { role: 'system', content: 'You are an objective and constructive university grading assistant. Output strictly JSON.' },
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

      const gradedItemsWithOriginal = (parsed?.gradedItems || []).map((item) => ({
        ...item,
        originalAwardedPoints: item.awardedPoints,
        isOverridden: false,
      }));

      const gradingRecord = await GradedSubmission.create({
        professorId: req.user._id,
        studentName,
        subject: subject || 'Academic Course',
        assignmentTitle,
        questionPaperText: finalQPText,
        submissionText: finalAnswerText,
        sourceExtractionMethod: extractionMethod,
        gradedItems: gradedItemsWithOriginal,
        totalScore: parsed?.totalScore || 0,
        maxScore: parsed?.maxScore || 100,
        percentage: parsed?.percentage || 0,
        overallGrade: parsed?.overallGrade || 'B',
        individualizedFeedback: parsed?.individualizedFeedback || 'Submission graded successfully.',
        keyStrengths: parsed?.keyStrengths || [],
        areasForGrowth: parsed?.areasForGrowth || [],
        gradedAt: new Date(),
      });

      res.status(201).json(gradingRecord);
    } catch (error) {
      console.error('[GradingExtractAndGrade] Error:', error);
      res.status(500).json({ error: error.message || 'Failed to evaluate submission.' });
    }
  }
);

// @route   PUT /api/professor/grading/:id/override
// @desc    Professor manually reviews and overrides AI-generated marks/feedback
router.put('/grading/:id/override', async (req, res) => {
  try {
    const { gradedItems, individualizedFeedback, overallGrade } = req.body;
    const submission = await GradedSubmission.findOne({
      _id: req.params.id,
      professorId: req.user._id,
    });

    if (!submission) {
      return res.status(404).json({ error: 'Graded submission not found or access denied.' });
    }

    if (gradedItems && Array.isArray(gradedItems)) {
      submission.gradedItems = gradedItems.map((item) => ({
        ...item,
        isOverridden: item.awardedPoints !== item.originalAwardedPoints,
      }));

      // Recalculate total score & percentage
      const totalScore = submission.gradedItems.reduce((acc, curr) => acc + Number(curr.awardedPoints || 0), 0);
      const maxScore = submission.gradedItems.reduce((acc, curr) => acc + Number(curr.maxPoints || 0), 0) || submission.maxScore || 100;
      submission.totalScore = totalScore;
      submission.maxScore = maxScore;
      submission.percentage = Math.round((totalScore / maxScore) * 100);
    }

    if (individualizedFeedback) {
      submission.individualizedFeedback = individualizedFeedback;
    }

    if (overallGrade) {
      submission.overallGrade = overallGrade;
    } else {
      const pct = submission.percentage;
      submission.overallGrade = pct >= 90 ? 'A' : pct >= 80 ? 'B+' : pct >= 70 ? 'B' : pct >= 60 ? 'C' : 'D';
    }

    submission.isReleased = true;

    await submission.save();

    // Sync to TestAttempt if it's an online submission
    if (submission.testAttemptId) {
      const TestAttempt = require('../models/TestAttempt');
      const attempt = await TestAttempt.findById(submission.testAttemptId);
      if (attempt) {
        attempt.score = submission.totalScore;
        attempt.totalMaxPoints = submission.maxScore;
        attempt.percentage = submission.percentage;
        attempt.aiDiagnosticFeedback = submission.individualizedFeedback || attempt.aiDiagnosticFeedback;
        attempt.isReleased = true;

        if (submission.gradedItems && submission.gradedItems.length > 0) {
          attempt.questions = attempt.questions.map((q, idx) => {
            const match = submission.gradedItems.find(
              (item) => item.questionNumber === idx + 1 || item.question === q.question
            );
            if (match) {
              return {
                questionId: q.questionId,
                questionType: q.questionType,
                question: q.question,
                options: q.options,
                correctAnswerIndex: q.correctAnswerIndex,
                correctTextAnswer: q.correctTextAnswer,
                userSelectedOption: q.userSelectedOption,
                userTextAnswer: q.userTextAnswer,
                awardedPoints: match.awardedPoints,
                isCorrect: match.awardedPoints >= (match.maxPoints * 0.6),
                points: q.points,
                explanation: q.explanation,
                rubricFeedback: match.evaluatorNotes || q.rubricFeedback,
                topicTag: q.topicTag
              };
            }
            return q;
          });

          // Recompute strengths and weaknesses
          const missed = attempt.questions.filter((q) => !q.isCorrect).map((q) => q.topicTag || 'General');
          const correct = attempt.questions.filter((q) => q.isCorrect).map((q) => q.topicTag || 'General');
          attempt.weakAreas = Array.from(new Set(missed)).filter(Boolean);
          attempt.strengths = Array.from(new Set(correct)).filter(Boolean);
          attempt.recommendedRevisionTopics = Array.from(new Set(missed)).filter(Boolean);
        }

        await attempt.save();
      }
    }

    res.json(submission);
  } catch (error) {
    console.error('[GradingOverride] Error:', error);
    res.status(500).json({ error: 'Failed to update grading overrides.' });
  }
});

// @route   GET /api/professor/grading/history
// @desc    Get all graded submissions evaluated by this professor
router.get('/grading/history', async (req, res) => {
  try {
    const history = await GradedSubmission.find({ professorId: req.user._id }).sort({ gradedAt: -1 });
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch grading history.' });
  }
});

// @route   DELETE /api/professor/grading/:id
// @desc    Delete a student submission record (and the associated test attempt, allowing them to retake if needed)
router.delete('/grading/:id', async (req, res) => {
  try {
    const submission = await GradedSubmission.findOne({
      _id: req.params.id,
      professorId: req.user._id,
    });

    if (!submission) {
      return res.status(404).json({ error: 'Graded submission not found or access denied.' });
    }

    // Delete associated TestAttempt if it exists
    if (submission.testAttemptId) {
      const TestAttempt = require('../models/TestAttempt');
      await TestAttempt.deleteOne({ _id: submission.testAttemptId });
    }

    await GradedSubmission.deleteOne({ _id: req.params.id });

    res.json({ message: 'Submission and associated attempt deleted successfully.', id: req.params.id });
  } catch (error) {
    console.error('[GradingDelete] Error:', error);
    res.status(500).json({ error: 'Failed to delete submission record.' });
  }
});

// ==========================================
// PROFESSOR TEST MANAGEMENT (OPTION A SCOPING & OPTION B ACCESS CODES)
// ==========================================

// @route   POST /api/professor/tests
// @desc    Create a new test and optionally send email invitations from uploaded student list
router.post('/tests', upload.single('studentExcel'), async (req, res) => {
  try {
    let {
      title,
      topic,
      subjectCode,
      subject,
      questions,
      accessCode = '',
      durationMinutes = 15,
      difficulty = 'Medium',
      professorName = '',
      courseId = '',
      manualEmails = '',
    } = req.body;

    // Parse fields if they are JSON strings (when uploaded via FormData)
    if (typeof questions === 'string') {
      try {
        questions = JSON.parse(questions);
      } catch (err) {
        return res.status(400).json({ error: 'Invalid questions JSON format.' });
      }
    }

    if (!title || !subjectCode || !questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        error: 'Please provide all required fields: title, subjectCode, and questions.',
      });
    }

    if (!accessCode || !accessCode.trim()) {
      return res.status(400).json({
        error: 'Access Code is required. Please provide a code for students to unlock the test.',
      });
    }

    const testDoc = await Test.create({
      title: title.trim(),
      topic: topic ? topic.trim() : title.trim(),
      department: 'General',
      year: 'General',
      semester: 'General',
      subjectCode: subjectCode.trim(),
      subject: subject ? subject.trim() : subjectCode.trim(),
      questions,
      accessCode: accessCode ? accessCode.trim() : '',
      createdBy: req.user._id,
      durationMinutes: Number(durationMinutes) || 15,
      difficulty,
      isPublished: true,
      professorName: professorName ? professorName.trim() : '',
      courseId: courseId ? courseId.trim() : '',
    });

    const emails = new Set();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // Parse manually entered emails
    if (manualEmails && typeof manualEmails === 'string') {
      const parts = manualEmails.split(',');
      for (const part of parts) {
        const trimmed = part.trim();
        if (emailRegex.test(trimmed)) {
          emails.add(trimmed);
        }
      }
    }

    // Check if a student email excel sheet was uploaded
    if (req.file) {
      try {
        const XLSX = require('xlsx');
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        for (const row of data) {
          if (!Array.isArray(row)) continue;
          for (const cell of row) {
            if (cell !== null && cell !== undefined) {
              const cellStr = String(cell).trim();
              if (emailRegex.test(cellStr)) {
                emails.add(cellStr);
              }
            }
          }
        }
      } catch (err) {
        console.error('[CreateTest] Excel parsing failed:', err.message);
      }
    }

    // Send invitations if emails exist
    const emailList = Array.from(emails);
    if (emailList.length > 0) {
      const { sendTestInvitations } = require('../services/emailService');
      // Send asynchronously without blocking response
      sendTestInvitations({
        testTitle: testDoc.title,
        accessCode: testDoc.accessCode,
        emails: emailList,
        subject: testDoc.subject,
        durationMinutes: testDoc.durationMinutes,
        courseId: testDoc.courseId,
        professorName: testDoc.professorName || req.user.name,
      }).catch((err) => {
        console.error('[CreateTest] Invitation dispatch error:', err.message);
      });
    }

    res.status(201).json(testDoc);
  } catch (error) {
    console.error('[CreateTest] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to create test.' });
  }
});

// @route   GET /api/professor/tests
// @desc    List all tests created by the logged-in professor
router.get('/tests', async (req, res) => {
  try {
    const tests = await Test.find({ createdBy: req.user._id }).sort({ createdAt: -1 });
    res.json(tests);
  } catch (error) {
    console.error('[GetProfessorTests] Error:', error);
    res.status(500).json({ error: 'Failed to fetch tests.' });
  }
});

// @route   DELETE /api/professor/tests/:id
// @desc    Delete a test created by the logged-in professor
router.delete('/tests/:id', async (req, res) => {
  try {
    const testDoc = await Test.findOneAndDelete({ _id: req.params.id, createdBy: req.user._id });
    if (!testDoc) {
      return res.status(404).json({ error: 'Test not found or access denied.' });
    }
    res.json({ message: 'Test deleted successfully.', id: req.params.id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete test.' });
  }
});

// @route   POST /api/professor/tests/generate-from-material
// @desc    Auto-generate structured test questions from uploaded syllabus/material or RAG vault
router.post('/tests/generate-from-material', upload.single('file'), async (req, res) => {
  try {
    const {
      subject = 'Computer Science',
      subjectCode = '',
      department = 'CSE',
      year = '3rd',
      topic = 'Course Material Test',
      difficulty = 'Medium',
      questionCount = 5,
      questionType = 'Mixed', // 'MCQ' | 'TrueFalse' | 'FillBlank' | 'ShortAnswer' | 'Mixed'
      rawText = '',
      selectedDocTitle = '',
    } = req.body;

    let materialContent = rawText || '';

    // Extract text from attached file if provided
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
          subject: subject || 'General',
          subjectCode: subjectCode || '',
          department: department || 'CSE',
          type: 'content',
          rawText: materialContent,
        });
      }
    }

    // Retrieve relevant chunks from professor's vault
    const relevantChunks = await retrieveRelevantChunks({
      subject,
      subjectCode: subjectCode || null,
      department: department || null,
      query: `${topic} ${subjectCode} ${selectedDocTitle} ${materialContent.slice(0, 200)} exam assessment questions`,
      topK: 4,
      userId: req.user._id,
      docTitle: selectedDocTitle || null,
    });

    let groundedContext = formatGroundedContext(relevantChunks);
    if (materialContent && materialContent.trim().length > 20) {
      groundedContext = `[ATTACHED COURSE MATERIAL]\n${materialContent.slice(0, 4000)}\n\n` + groundedContext;
    }

    const qCount = Number(questionCount) || 5;

    const prompt = `You are an Expert University Professor and Assessment Examiner creating a curriculum-aligned test grounded strictly in course material.

Target Metadata:
- Subject: ${subject} (${subjectCode || 'Code'})
- Department: ${department}
- Academic Year: ${year}
- Topic: ${topic}
- Difficulty: ${difficulty}
- Total Questions Needed: ${qCount}
- Test Type / Question Format: ${questionType}

Supported Question Format Types:
1. "MCQ" (Multiple Choice): 4 options in "options" array, "correctAnswerIndex" (0-3), "correctTextAnswer" (exact text of correct option).
2. "TrueFalse" (True / False): "options" = ["True", "False"], "correctAnswerIndex" (0 for True, 1 for False), "correctTextAnswer" = "True" or "False".
3. "FillBlank" (Fill in the Blank): question contains a blank "_____", "options" = [], "correctTextAnswer" = exact keyword/term to complete the sentence.
4. "ShortAnswer" (Short Answer): question requiring 1-3 sentences, "options" = [], "correctTextAnswer" = comprehensive expected model answer key & core concepts.

${
  questionType === 'Mixed'
    ? 'Please create a balanced mix of MCQ, True/False, Fill in the Blank, and Short Answer questions.'
    : `All ${qCount} questions MUST be of questionType "${questionType}".`
}

COURSE MATERIAL REFERENCE (GROUNDING):
${groundedContext}

Return ONLY valid JSON matching this exact structure:
{
  "suggestedTitle": "${subjectCode || subject} - ${topic} Assessment",
  "suggestedTopic": "${topic}",
  "questions": [
    {
      "questionType": "MCQ",
      "question": "Question statement?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswerIndex": 0,
      "correctTextAnswer": "Option A",
      "points": 2,
      "explanation": "Detailed explanation of the solution",
      "topicTag": "Subtopic Name"
    },
    {
      "questionType": "FillBlank",
      "question": "The protocol requires a quorum of _____ nodes to commit writes.",
      "options": [],
      "correctAnswerIndex": 0,
      "correctTextAnswer": "majority",
      "points": 2,
      "explanation": "A majority quorum ensures no two conflicting writes are committed.",
      "topicTag": "Quorums"
    },
    {
      "questionType": "ShortAnswer",
      "question": "Explain the fundamental trade-off of the CAP theorem.",
      "options": [],
      "correctAnswerIndex": 0,
      "correctTextAnswer": "During a network partition P, a system must choose between consistency C (linearizability) or availability A.",
      "points": 3,
      "explanation": "Brewer's theorem proves simultaneous CP and AP is impossible under partition.",
      "topicTag": "CAP Theorem"
    }
  ]
}`;

    const completion = await generateChatCompletion({
      messages: [
        { role: 'system', content: 'You are an academic examination author. Output strictly JSON.' },
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
      suggestedTitle: parsed.suggestedTitle || `${subject} (${topic}) Test`,
      suggestedTopic: parsed.suggestedTopic || topic,
      questions: parsed.questions || [],
    });
  } catch (error) {
    console.error('[ProfessorGenerateTest] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate test questions from material.' });
  }
});

// @route   POST /api/professor/materials/share-email
// @desc    Dispatch course notes & study materials directly to student emails / class roster via Gmail
router.post(
  '/materials/share-email',
  upload.fields([
    { name: 'excelRoster', maxCount: 1 },
    { name: 'attachedDoc', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      let {
        notesTitle = 'Course Lecture Notes',
        topic = '',
        subject = '',
        notesContent = '',
        manualEmails = '',
        courseId = '',
      } = req.body;

      let finalNotesContent = notesContent ? notesContent.trim() : '';
      const docFile = req.files?.attachedDoc?.[0];

      if (!finalNotesContent && !docFile) {
        return res.status(400).json({ error: 'Please enter notes content or attach a document file to share with students.' });
      }

      if (!finalNotesContent && docFile) {
        finalNotesContent = `Please find the attached course material: "${docFile.originalname}" shared by your professor.`;
      }

      const emails = new Set();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      // Parse manual emails
      if (manualEmails && typeof manualEmails === 'string') {
        const parts = manualEmails.split(/[,;\n]/);
        for (const part of parts) {
          const trimmed = part.trim();
          if (emailRegex.test(trimmed)) {
            emails.add(trimmed);
          }
        }
      }

      // Check if Excel roster file was uploaded
      const excelFile = req.files?.excelRoster?.[0];
      if (excelFile) {
        try {
          const XLSX = require('xlsx');
          const workbook = XLSX.read(excelFile.buffer, { type: 'buffer' });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

          for (const row of data) {
            if (!Array.isArray(row)) continue;
            for (const cell of row) {
              if (cell !== null && cell !== undefined) {
                const cellStr = String(cell).trim();
                if (emailRegex.test(cellStr)) {
                  emails.add(cellStr);
                }
              }
            }
          }
        } catch (err) {
          console.error('[ShareNotes] Excel roster parsing error:', err.message);
        }
      }

      const emailList = Array.from(emails);
      if (emailList.length === 0) {
        return res.status(400).json({
          error: 'No valid recipient email addresses found. Please enter manual emails or upload an Excel student roster.',
        });
      }

      // Prepare attachments if provided
      const attachments = [];
      if (docFile) {
        attachments.push({
          filename: docFile.originalname,
          content: docFile.buffer,
        });
      }

      const { sendSharedNotesEmail } = require('../services/emailService');

      const result = await sendSharedNotesEmail({
        notesTitle: notesTitle.trim(),
        topic: topic.trim(),
        subject: subject.trim(),
        notesContent: finalNotesContent,
        emails: emailList,
        professorName: req.user.name,
        courseId: courseId.trim(),
        attachments,
      });

      res.json({
        message: `Successfully dispatched study notes to ${result.count} recipient(s).`,
        count: result.count,
        loggedOnly: result.loggedOnly,
        recipients: emailList,
      });
    } catch (error) {
      console.error('[ShareNotesEmail] Error:', error);
      res.status(500).json({ error: error.message || 'Failed to dispatch notes email.' });
    }
  }
);

module.exports = router;

