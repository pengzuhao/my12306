import type { FastifyPluginAsync } from 'fastify';
import { TasksRepo } from '../db/repo.js';
import { currentUser } from './auth.routes.js';
export const miscRoutes: FastifyPluginAsync = async app => {
  app.get('/api/tasks', async request => TasksRepo.list(currentUser(request).id, 100));
};
