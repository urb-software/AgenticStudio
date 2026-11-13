import { PrismaClient } from './generated/prisma/client.js';

export class ListProjectsHandler {
  readonly client = PrismaClient;
}
