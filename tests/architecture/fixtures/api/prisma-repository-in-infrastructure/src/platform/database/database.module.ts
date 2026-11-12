import { Module } from '@nestjs/common';

export const DATABASE_CLIENT = Symbol('DATABASE_CLIENT');

@Module({ providers: [{ provide: DATABASE_CLIENT, useValue: {} }], exports: [DATABASE_CLIENT] })
export class DatabaseModule {}
