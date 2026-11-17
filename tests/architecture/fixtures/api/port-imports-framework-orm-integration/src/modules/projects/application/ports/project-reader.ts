import type { Repository } from '@nestjs/typeorm';

export type ProjectReader = Repository<{ id: string; name: string }>;
