import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import routes from './routes/index.js';
import { validateConfig } from './config/google-hybrid.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// CORS
// - Fixes: your server was sending Access-Control-Allow-Origin: http://localhost:3000
// - Now: allows the Vercel domain + localhost (and optional extra origins via FRONTEND_URL / FRONTEND_URLS)
const defaultAllowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://visit-prop-6i8s.vercel.app',
];

const envOrigins = [
  process.env.FRONTEND_URL,
  ...(process.env.FRONTEND_URLS ? process.env.FRONTEND_URLS.split(',') : []),
]
  .map((s) => (s || '').trim())
  .filter(Boolean);

const allowedOrigins = Array.from(new Set([...defaultAllowedOrigins, ...envOrigins]));

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // allow server-to-server / curl
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Mount all routes (includes /auth and /api)
app.use('/', routes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'VisitProp Backend API (OAuth 2.0)',
    version: '2.0.0',
    authentication: '/auth/login',
    documentation: '/api/health',
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Server Error:', err.message);
  if (process.env.NODE_ENV === 'development') {
    console.error('   Stack:', err.stack);
  }

  // Handle Multer errors (file upload errors)
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        message: 'Maximum file size is 10MB',
        details: `The uploaded file exceeds the 10MB size limit`,
        code: 'LIMIT_FILE_SIZE',
      });
    } else if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error: 'Too many files',
        message: 'Maximum 10 files allowed',
        details: 'You can upload up to 10 files at once',
        code: 'LIMIT_FILE_COUNT',
      });
    } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error: 'Unexpected file field',
        message: 'Invalid file field name',
        details: 'Use "file" for single upload or "files" for multiple uploads',
        code: 'LIMIT_UNEXPECTED_FILE',
      });
    } else {
      return res.status(400).json({
        error: 'File upload error',
        message: err.message,
        details: 'An error occurred during file upload',
        code: err.code,
      });
    }
  }

  // Handle file filter errors (file type validation)
  if (
    err.message?.includes('Only image files are allowed') ||
    err.message?.includes('Only images, PDFs, Word documents')
  ) {
    return res.status(400).json({
      error: 'Invalid file type',
      message: err.message,
      details: 'Please check the allowed file types for this subfolder',
      code: 'INVALID_FILE_TYPE',
    });
  }

  // General error handling
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    details: err.status === 500 ? 'An unexpected error occurred. Please try again.' : err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Cannot ${req.method} ${req.path}`,
  });
});

// Start server
async function startServer() {
  try {
    // Validate configuration
    console.log('🔍 Validating configuration...');
    validateConfig();
    console.log('✅ Configuration valid');

    // Start listening
    app.listen(PORT, () => {
      console.log('');
      console.log('🚀 ========================================');
      console.log('✅ VisitProp Backend Server is running!');
      console.log(`📍 URL: http://localhost:${PORT}`);
      console.log('========================================');
      console.log('');
      console.log('📝 API Endpoints:');
      console.log(`   GET  http://localhost:${PORT}/api/health`);
      console.log(`   GET  http://localhost:${PORT}/api/properties?search=<query>`);
      console.log(`   POST http://localhost:${PORT}/api/upload`);
      console.log(`   POST http://localhost:${PORT}/api/reports`);
      console.log(`   GET  http://localhost:${PORT}/api/reports`);
      console.log('');
      console.log('🌐 CORS Allowed Origins:');
      allowedOrigins.forEach((o) => console.log(`   ✅ ${o}`));
      console.log('');
      console.log('🔗 Connected Services:');
      console.log(`   📊 Properties Sheet: ${process.env.GOOGLE_SHEETS_PROPERTIES_ID}`);
      console.log(`   📋 Reports Sheet: ${process.env.GOOGLE_SHEETS_REPORTS_ID}`);
      console.log(`   📁 Drive Folder: ${process.env.GOOGLE_DRIVE_FOLDER_ID}`);
      console.log('');
      console.log('✨ Ready to accept requests!');
      console.log('');
    });
  } catch (error) {
    console.error('❌ Failed to start server:');
    console.error(error.message);
    console.error('');
    console.error('Please check:');
    console.error('  1. Your .env file exists and has all required variables');
    console.error('  2. Your google-credentials.json file exists');
    console.error('  3. Your Google Sheets and Drive IDs are correct');
    console.error('');
    process.exit(1);
  }
}

startServer();
