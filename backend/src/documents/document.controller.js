const express = require('express');
const multer = require('multer');
const env = require('../config/env');
const documentService = require('./document.service');
const { checkRole } = require('../middleware/rbac');
const AppError = require('../utils/AppError');

const router = express.Router();

// Configure Multer for in-memory handling with size limit
const maxSizeBytes = (env.MAX_FILE_SIZE_MB || 10) * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxSizeBytes,
  },
});

// Middleware to wrap multer upload with standard error handling
function uploadSingleFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new AppError(`File size exceeds maximum limit of ${env.MAX_FILE_SIZE_MB}MB.`, 413));
        }
        return next(new AppError(`Upload error: ${err.message}`, 400));
      }
      return next(err);
    }
    next();
  });
}

// 1. Upload document (Admin & Member only)
router.post('/', checkRole(['admin', 'member']), uploadSingleFile, async (req, res, next) => {
  try {
    const orgId = res.locals.tenantId || req.tenantId;
    const userId = req.user.id;

    if (!req.file) {
      return next(new AppError('No file uploaded. Expected field name: "file"', 400));
    }

    const document = await documentService.uploadDocument({
      userId,
      orgId,
      file: req.file,
    });

    res.status(201).json({
      status: 'success',
      data: {
        document,
      },
    });
  } catch (err) {
    next(err);
  }
});

// 2. List documents (Admin, Member, Viewer)
router.get('/', checkRole(['admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const orgId = res.locals.tenantId || req.tenantId;
    const { page, limit } = req.query;

    const result = await documentService.listDocuments({
      orgId,
      page,
      limit,
    });

    res.status(200).json({
      status: 'success',
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

// 3. Get document metadata (Admin, Member, Viewer)
router.get('/:documentId', checkRole(['admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const orgId = res.locals.tenantId || req.tenantId;
    const { documentId } = req.params;

    const document = await documentService.getDocument({
      orgId,
      documentId,
    });

    res.status(200).json({
      status: 'success',
      data: {
        document,
      },
    });
  } catch (err) {
    next(err);
  }
});

// 4. Download document stream (Admin, Member, Viewer)
router.get('/:documentId/download', checkRole(['admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const orgId = res.locals.tenantId || req.tenantId;
    const { documentId } = req.params;

    const { stream, doc } = await documentService.downloadDocument({
      orgId,
      documentId,
    });

    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.original_name)}"`);
    res.setHeader('Content-Length', doc.file_size);

    stream.on('error', (err) => {
      console.error('Error streaming file from MinIO:', err);
      if (!res.headersSent) {
        return next(new AppError('Failed to stream file.', 500));
      }
    });

    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

// 5. Delete document (Admin & Member only)
router.delete('/:documentId', checkRole(['admin', 'member']), async (req, res, next) => {
  try {
    const orgId = res.locals.tenantId || req.tenantId;
    const { documentId } = req.params;
    const userId = req.user.id;

    await documentService.deleteDocument({
      orgId,
      documentId,
      userId,
    });

    res.status(200).json({
      status: 'success',
      message: 'Document deleted successfully',
    });
  } catch (err) {
    next(err);
  }
});

// 6. Update document metadata / rename (Admin & Member only)
router.patch('/:documentId', checkRole(['admin', 'member']), async (req, res, next) => {
  try {
    const orgId = res.locals.tenantId || req.tenantId;
    const { documentId } = req.params;
    const { filename } = req.body;
    const userId = req.user.id;

    const document = await documentService.updateDocumentMetadata({
      orgId,
      documentId,
      filename,
      userId,
    });

    res.status(200).json({
      status: 'success',
      data: {
        document,
      },
    });
  } catch (err) {
    next(err);
  }
});

// 7. Get document processing status (Admin, Member, Viewer)
router.get('/:documentId/processing', checkRole(['admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const orgId = res.locals.tenantId || req.tenantId;
    const { documentId } = req.params;

    const statusInfo = await documentService.getProcessingStatus({
      orgId,
      documentId,
    });

    res.status(200).json({
      status: 'success',
      data: statusInfo,
    });
  } catch (err) {
    next(err);
  }
});

// 8. Trigger document reprocessing (Admin & Member only)
router.post('/:documentId/reprocess', checkRole(['admin', 'member']), async (req, res, next) => {
  try {
    const orgId = res.locals.tenantId || req.tenantId;
    const { documentId } = req.params;
    const userId = req.user.id;

    const result = await documentService.reprocessDocument({
      orgId,
      documentId,
      userId,
    });

    res.status(200).json({
      status: 'success',
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
