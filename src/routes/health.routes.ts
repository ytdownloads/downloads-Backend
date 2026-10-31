import { Router } from 'express';
import { getHealthCheck, getHealthProbe } from '../controllers/health.controller.js';

export const healthRouter = Router();

healthRouter.get('/health', getHealthCheck);
healthRouter.get('/health/probe', getHealthProbe);


