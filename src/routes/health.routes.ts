import { Router } from 'express';
import { getHealthCheck, getProbeCheck } from '../controllers/health.controller.js';

export const healthRouter = Router();

healthRouter.get('/health', getHealthCheck);
healthRouter.get('/probe', getProbeCheck);

