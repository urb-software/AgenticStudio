import { Injectable } from '../../../../shared/framework.js';

export class ProjectNamePolicy {
  constructor(private readonly marker: typeof Injectable) {}

  normalize(name: string): string {
    return `${this.marker.name}:${name.trim().toLowerCase()}`;
  }
}
