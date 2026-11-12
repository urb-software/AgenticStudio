import Docker from 'dockerode';

export class PreviewPolicy {
  constructor(private readonly docker: Docker) {}

  async canStart(): Promise<boolean> {
    return (await this.docker.listContainers()).length < 10;
  }
}
