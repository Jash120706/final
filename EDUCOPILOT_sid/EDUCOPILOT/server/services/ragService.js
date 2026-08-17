const CourseDocChunk = require('../models/CourseDocChunk');
const { chunkText, extractKeywords, calculateSimilarity } = require('./embeddingService');
const pdfParse = require('pdf-parse');

/**
 * Ingest document content into RAG vector chunks
 */
const ingestDocument = async ({
  uploadedBy,
  docTitle,
  subject,
  subjectCode = '',
  department = 'CSE',
  type = 'content',
  courseCode = '',
  rawText = '',
  fileBuffer = null,
}) => {
  let fullText = rawText;

  if (fileBuffer) {
    try {
      const pdfData = await pdfParse(fileBuffer);
      if (pdfData && pdfData.text && pdfData.text.trim().length >= 10) {
        fullText = pdfData.text;
      } else {
        // Fallback ASCII/UTF8 extraction
        const rawStr = fileBuffer.toString('utf-8');
        const matches = rawStr.match(/[\x20-\x7E\r\n]{4,}/g);
        fullText = matches ? matches.join(' ') : rawStr;
      }
    } catch (err) {
      console.warn('[RAG] PDF parse note, falling back to text stream decode:', err.message);
      const rawStr = fileBuffer.toString('utf-8');
      const matches = rawStr.match(/[\x20-\x7E\r\n]{4,}/g);
      fullText = matches ? matches.join(' ') : rawStr;
    }
  }

  // Clean and normalize extracted text
  if (fullText) {
    fullText = fullText.replace(/\x00/g, '').replace(/\r\n/g, '\n').trim();
  }

  if (!fullText || fullText.length < 10) {
    throw new Error('Document content could not be extracted or is too short to index. Please ensure the document contains readable text.');
  }

  const normalizedSubjectCode = (subjectCode || courseCode || '').toUpperCase().trim();
  const normalizedDepartment = (department || 'CSE').toUpperCase().trim();
  const normalizedType = ['syllabus', 'content', 'notes', 'other'].includes(type) ? type : 'content';

  // Delete previous chunks of same document for this user & subject
  await CourseDocChunk.deleteMany({ docTitle, subject, uploadedBy });

  const rawChunks = chunkText(fullText, 1200, 200);
  const docsToInsert = rawChunks.map((chunk, index) => ({
    uploadedBy,
    docTitle,
    subject,
    subjectCode: normalizedSubjectCode,
    department: normalizedDepartment,
    type: normalizedType,
    courseCode: normalizedSubjectCode || courseCode,
    chunkIndex: index + 1,
    chunkText: chunk.text,
    tokenCount: chunk.tokenCount,
    keywords: chunk.keywords,
  }));

  const inserted = await CourseDocChunk.insertMany(docsToInsert);
  return {
    totalChunks: inserted.length,
    docTitle,
    subject,
    subjectCode: normalizedSubjectCode,
    department: normalizedDepartment,
    type: normalizedType,
  };
};

/**
 * Retrieve top-k relevant course chunks scoped by subjectCode, department, user, and subject (Strict Data Isolation)
 */
const retrieveRelevantChunks = async ({
  subjectCode = null,
  department = null,
  type = null,
  subject = null,
  query,
  topK = 4,
  userId = null,
  docTitle = null,
}) => {
  // Query chunks matching subjectCode and/or user's isolated storage
  const filter = {};
  if (userId) {
    filter.uploadedBy = userId;
  }
  if (subjectCode && subjectCode !== 'All') {
    filter.subjectCode = { $regex: new RegExp(`^${subjectCode.trim()}$`, 'i') };
  }
  if (department && department !== 'All') {
    filter.department = { $regex: new RegExp(`^${department.trim()}$`, 'i') };
  }
  if (type && type !== 'All') {
    filter.type = type;
  }
  if (docTitle && docTitle !== 'All') {
    filter.docTitle = { $regex: new RegExp(`^${docTitle.trim()}$`, 'i') };
  }
  if (subject && subject !== 'All') {
    filter.subject = { $regex: new RegExp(`^${subject.trim()}$`, 'i') };
  }

  let chunks = await CourseDocChunk.find(filter).lean();

  // If no chunks found with user filter, fall back to global course knowledge only if userId is NOT provided
  if (!userId) {
    if ((!chunks || chunks.length === 0) && (subjectCode || (subject && subject !== 'All'))) {
      const fallbackFilter = {};
      if (subjectCode && subjectCode !== 'All') {
        fallbackFilter.subjectCode = { $regex: new RegExp(`^${subjectCode.trim()}$`, 'i') };
      }
      if (subject && subject !== 'All' && !subjectCode) {
        fallbackFilter.subject = { $regex: new RegExp(`^${subject.trim()}$`, 'i') };
      }
      if (docTitle && docTitle !== 'All') {
        fallbackFilter.docTitle = { $regex: new RegExp(`^${docTitle.trim()}$`, 'i') };
      }
      if (type && type !== 'All') {
        fallbackFilter.type = type;
      }
      chunks = await CourseDocChunk.find(fallbackFilter).lean();
    } else if (!chunks || chunks.length === 0) {
      chunks = await CourseDocChunk.find({}).limit(50).lean();
    }
  }

  if (!chunks || chunks.length === 0) {
    return [];
  }

  // Score each chunk
  const scored = chunks.map((chunk) => {
    const similarity = calculateSimilarity(
      query,
      chunk.chunkText,
      chunk.keywords || []
    );
    return {
      docTitle: chunk.docTitle,
      subject: chunk.subject,
      subjectCode: chunk.subjectCode || chunk.courseCode || '',
      department: chunk.department || 'CSE',
      type: chunk.type || 'content',
      chunkIndex: chunk.chunkIndex,
      chunkText: chunk.chunkText,
      relevanceScore: parseFloat(similarity.toFixed(3)),
    };
  });

  // Sort by highest relevance score and return top K
  return scored
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, topK);
};

/**
 * Build grounded prompt context from retrieved chunks
 */
const formatGroundedContext = (retrievedChunks) => {
  if (!retrievedChunks || retrievedChunks.length === 0) {
    return 'No specific uploaded course document chunks found for this subject. Ground responses using standard academic domain principles.';
  }

  return retrievedChunks
    .map(
      (c, i) =>
        `[Source Document ${i + 1}: "${c.docTitle}" | Code: ${c.subjectCode || 'N/A'} | Dept: ${c.department || 'CSE'} | Type: ${c.type || 'content'} | Score: ${c.relevanceScore}]\n${c.chunkText}`
    )
    .join('\n\n---\n\n');
};

module.exports = {
  ingestDocument,
  retrieveRelevantChunks,
  formatGroundedContext,
};
