import { Router } from 'express';
import {
  createBatch,
  getBatchEvents,
  getBatchStatus,
  getBatchZip,
  getBatchItemFile,
  cancelBatch,
  cancelBatchItem,
  retryBatch,
  addBatchItems,
} from '../controllers/batch.controller.js';

export const batchRouter = Router();

batchRouter.post('/batch', createBatch);
batchRouter.get('/batch/:batchJobId', getBatchStatus);
batchRouter.get('/batch/:batchJobId/events', getBatchEvents);
batchRouter.get('/batch/:batchJobId/status', getBatchStatus);
batchRouter.get('/batch/:batchJobId/zip', getBatchZip);
batchRouter.get('/batch/:batchJobId/items/:itemId/file', getBatchItemFile);
batchRouter.post('/batch/:batchJobId/items/:itemId/cancel', cancelBatchItem);
batchRouter.post('/batch/:batchJobId/items', addBatchItems);
batchRouter.post('/batch/:batchJobId/add-items', addBatchItems);
batchRouter.post('/batch/:batchJobId/cancel', cancelBatch);
batchRouter.post('/batch/:batchJobId/retry', retryBatch);
