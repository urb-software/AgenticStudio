const { object, string } = require('valibot');

export const ProjectArchivedV1Schema = object({ projectId: string() });
