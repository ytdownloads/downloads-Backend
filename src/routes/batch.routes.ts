import { Router } from 'express';
import {
  createBatch,
  getBatchEvents,
  getBatchStatus,
  getBatchZip,
  getBatchItemFile,
  cancelBatch,
  retryBatch,
} from '../controllers/batch.controller.js';

export const batchRouter = Router();

batchRouter.post('/batch', createBatch);
batchRouter.get('/batch/:batchJobId/events', getBatchEvents);
batchRouter.get('/batch/:batchJobId/status', getBatchStatus);
batchRouter.get('/batch/:batchJobId/zip', getBatchZip);
batchRouter.get('/batch/:batchJobId/items/:itemId/file', getBatchItemFile);
batchRouter.post('/batch/:batchJobId/cancel', cancelBatch);
batchRouter.post('/batch/:batchJobId/retry', retryBatch);
