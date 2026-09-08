import { Router } from 'express';
import {
  createDownload,
  getDownloadEvents,
  getDownloadStatus,
  getDownloadFile,
  cancelDownload,
} from '../controllers/download.controller.js';

export const downloadRouter = Router();

downloadRouter.post('/download', createDownload);
downloadRouter.get('/download/:jobId/events', getDownloadEvents);
downloadRouter.get('/download/:jobId/status', getDownloadStatus);
downloadRouter.get('/download/:jobId/file', getDownloadFile);
downloadRouter.post('/download/:jobId/cancel', cancelDownload);
