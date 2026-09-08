import { Router } from 'express';
import { getMediaInfo } from '../controllers/info.controller.js';

export const infoRouter = Router();

infoRouter.post('/info', getMediaInfo);
