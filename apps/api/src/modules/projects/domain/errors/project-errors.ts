/** Another project already has this name (compared by `ProjectName.uniquenessKey`). */
export class ProjectNameTakenError extends Error {
  constructor() {
    super('A project with this name already exists.');
    this.name = 'ProjectNameTakenError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor() {
    super('The project does not exist.');
    this.name = 'ProjectNotFoundError';
  }
}
