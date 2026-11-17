import { Injectable } from '@nestjs/common';

@Injectable()
export class ProjectNamePolicy {
  normalize(name: string): string {
    return name.trim().toLowerCase();
  }
}
