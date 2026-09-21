import { Router } from 'express';
import { healthRouter } from './health.routes.js';
import { infoRouter } from './info.routes.js';
import { downloadRouter } from './download.routes.js';
import { batchRouter } from './batch.routes.js';

export const apiRouter = Router();

// Mount sub-routers
apiRouter.use('/', healthRouter);
apiRouter.use('/', infoRouter);
apiRouter.use('/', downloadRouter);
apiRouter.use('/', batchRouter);
apiRouter.use('/download', batchRouter);
