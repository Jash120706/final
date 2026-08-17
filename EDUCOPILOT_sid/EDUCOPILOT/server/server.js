const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const path = require('path');

const connectDB = require('./config/db');

// Load environment variables
dotenv.config();

const app = express();

// =========================================
// MIDDLEWARES
// =========================================

app.use(cors());

app.use(express.json({ limit: '20mb' }));

app.use(express.urlencoded({
  extended: true,
  limit: '20mb'
}));

// =========================================
// DATABASE CONNECTION CHECK
// =========================================

app.use((req, res, next) => {

  // Health check should always work
  if (req.path === '/api/health') {
    return next();
  }

  // Allow frontend files to load
  if (!req.path.startsWith('/api')) {
    return next();
  }

  // Check MongoDB only for API requests
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: 'Database is currently unavailable. Please ensure MongoDB is running.'
    });
  }

  next();
});

// =========================================
// API ROUTES
// =========================================

app.use('/api/auth', require('./routes/auth'));

app.use('/api/student', require('./routes/student'));

app.use('/api/professor', require('./routes/professor'));

app.use('/api/rag', require('./routes/rag'));

app.use('/api/support', require('./routes/support'));

// =========================================
// HEALTH CHECK
// =========================================

app.get('/api/health', (req, res) => {

  const dbStatus =
    mongoose.connection.readyState === 1
      ? 'connected'
      : 'disconnected';

  res.json({
    status: 'ok',
    database: dbStatus,
    service: 'EduCopilot Backend API',
    llmProvider: process.env.GROQ_API_KEY
      ? 'Groq API'
      : 'Fallback Engine (Active)',
    model: process.env.GROQ_MODEL ||
      'llama-3.3-70b-versatile',
    timestamp: new Date().toISOString()
  });

});

// =========================================
// SERVE REACT FRONTEND
// =========================================

// Docker structure:
//
// /app
// ├── server
// │   └── server.js
// │
// └── client
//     └── dist
//         └── index.html

const clientPath = path.join(__dirname, '../client/dist');

console.log('[Frontend] Client path:', clientPath);

// Serve React static files
app.use(express.static(clientPath));

// React Router fallback
app.get('*', (req, res, next) => {

  // Do not intercept API routes
  if (req.path.startsWith('/api')) {
    return next();
  }

  res.sendFile(
    path.join(clientPath, 'index.html'),
    (err) => {

      if (err) {
        console.error('[Frontend] Failed to serve index.html:', err);

        return res.status(500).json({
          error: 'Frontend build not found',
          path: clientPath
        });
      }

    }
  );

});

// =========================================
// 404 HANDLER
// =========================================

app.use((req, res, next) => {

  res.status(404).json({
    error: `API route not found: ${req.originalUrl}`
  });

});

// =========================================
// GLOBAL ERROR HANDLER
// =========================================

app.use((err, req, res, next) => {

  console.error(
    '[Server Error]',
    err.stack || err
  );

  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });

});

// =========================================
// START SERVER
// =========================================

const PORT = process.env.PORT || 5000;

const startServer = async () => {

  try {

    // Connect MongoDB
    await connectDB();

    // Start Express
    app.listen(PORT, '0.0.0.0', () => {

      console.log('=========================================');

      console.log(
        `🚀 EduCopilot API Server running on port ${PORT}`
      );

      console.log(
        `🔗 Health Check: http://localhost:${PORT}/api/health`
      );

      console.log(
        `🌐 Frontend: http://localhost:${PORT}/`
      );

      console.log('=========================================');

    });

  } catch (error) {

    console.error(
      '[Server] Failed to start:',
      error
    );

    process.exit(1);

  }

};

startServer();
