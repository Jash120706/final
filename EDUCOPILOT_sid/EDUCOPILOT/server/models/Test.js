const mongoose = require('mongoose');

const testQuestionSchema = new mongoose.Schema({
  questionId: {
    type: String,
    default: () => new mongoose.Types.ObjectId().toString(),
  },
  questionType: {
    type: String,
    enum: ['MCQ', 'TrueFalse', 'FillBlank', 'ShortAnswer', 'Descriptive'],
    default: 'MCQ',
  },
  question: {
    type: String,
    required: true,
  },
  options: {
    type: [String],
    default: [],
  },
  correctAnswerIndex: {
    type: Number,
    default: 0,
  },
  correctTextAnswer: {
    type: String,
    default: '',
  },
  points: {
    type: Number,
    default: 1,
  },
  explanation: {
    type: String,
    default: '',
  },
  topicTag: {
    type: String,
    default: '',
  },
});

const testSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    topic: {
      type: String,
      required: true,
      trim: true,
    },
    department: {
      type: String,
      default: 'General',
      trim: true,
      index: true,
    },
    year: {
      type: String,
      default: 'General',
      trim: true,
      index: true,
    },
    semester: {
      type: String,
      default: 'General',
      trim: true,
    },
    subjectCode: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    questions: [testQuestionSchema],
    accessCode: {
      type: String,
      default: '',
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    durationMinutes: {
      type: Number,
      default: 15,
    },
    difficulty: {
      type: String,
      enum: ['Easy', 'Medium', 'Hard', 'Adaptive'],
      default: 'Medium',
    },
    isPublished: {
      type: Boolean,
      default: true,
    },
    professorName: {
      type: String,
      default: '',
      trim: true,
    },
    courseId: {
      type: String,
      default: '',
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Test', testSchema);
