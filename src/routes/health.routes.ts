import { Router } from 'express';
import { getHealthCheck, postDiagnose } from '../controllers/health.controller.js';

export const healthRouter = Router();

healthRouter.get('/health', getHealthCheck);
healthRouter.post('/diagnose', postDiagnose);
