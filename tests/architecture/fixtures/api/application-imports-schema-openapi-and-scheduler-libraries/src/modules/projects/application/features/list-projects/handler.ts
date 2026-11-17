import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApiProperty } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

export class ProjectDto extends createZodDto({} as never) {
  @ApiProperty()
  name!: string;
}

export type ListProjectsResult = ProjectDto[];

@Injectable()
export class ListProjectsHandler {
  @Cron('0 * * * *')
  async execute(): Promise<ListProjectsResult> {
    return [];
  }
}
