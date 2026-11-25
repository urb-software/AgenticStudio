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

/** A definitions Project exists already; at most one does. */
export class DefinitionsProjectExistsError extends Error {
  constructor() {
    super('A definitions Repository is already connected.');
    this.name = 'DefinitionsProjectExistsError';
  }
}

/**
 * The Project is the definitions Repository, which accepts no Run, no Preview and no Environment
 * file.
 */
export class DefinitionsProjectError extends Error {
  constructor() {
    super('The definitions Repository accepts no Run, no Preview and no Environment file.');
    this.name = 'DefinitionsProjectError';
  }
}
