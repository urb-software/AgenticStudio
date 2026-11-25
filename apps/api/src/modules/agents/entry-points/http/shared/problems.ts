import { HttpStatus } from '@nestjs/common';
import { ProblemException } from '../../../../../platform/http/problem-details.js';

/** Problem `type` URIs of the agents API (RFC 9457). */
export const AGENTS_PROBLEM_TYPES = {
  agentNotFound: 'urn:agentic-studio:problem:agent-not-found',
  agentFileNotFound: 'urn:agentic-studio:problem:agent-file-not-found',
  agentCommitNotFound: 'urn:agentic-studio:problem:agent-commit-not-found',
  agentFilesUnreadable: 'urn:agentic-studio:problem:agent-files-unreadable',
  projectNotFound: 'urn:agentic-studio:problem:project-not-found',
  definitionsProject: 'urn:agentic-studio:problem:definitions-project',
  draftFileTooLarge: 'urn:agentic-studio:problem:agent-draft-file-too-large',
  draftTooLarge: 'urn:agentic-studio:problem:agent-draft-too-large',
  draftTooManyFiles: 'urn:agentic-studio:problem:agent-draft-too-many-files',
  draftPathNotWritable: 'urn:agentic-studio:problem:agent-draft-path-not-writable',
  draftPathTaken: 'urn:agentic-studio:problem:agent-draft-path-taken',
  draftPathConflict: 'urn:agentic-studio:problem:agent-draft-path-conflict',
  draftMoveUnsupported: 'urn:agentic-studio:problem:agent-draft-move-unsupported',
  draftNoBase: 'urn:agentic-studio:problem:agent-draft-no-base',
  draftConflict: 'urn:agentic-studio:problem:agent-draft-conflict',
  draftBaseMissing: 'urn:agentic-studio:problem:agent-draft-base-missing',
  publishNotConfigured: 'urn:agentic-studio:problem:publish-not-configured',
  publishRunning: 'urn:agentic-studio:problem:publish-running',
  nothingToPublish: 'urn:agentic-studio:problem:nothing-to-publish',
  repositoryMoved: 'urn:agentic-studio:problem:repository-moved',
  writeRefused: 'urn:agentic-studio:problem:write-refused',
  publishProblems: 'urn:agentic-studio:problem:publish-problems',
  publishFailed: 'urn:agentic-studio:problem:publish-failed',
} as const;

/** 404 for a project id that names no project (also one that is not a UUID). */
export function projectNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: AGENTS_PROBLEM_TYPES.projectNotFound,
    title: 'Project not found',
    detail: 'No project has this id.',
  });
}

/** 409 for the definitions Project, which accepts no Run and so offers no agent for one. */
export function definitionsProject(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: AGENTS_PROBLEM_TYPES.definitionsProject,
    title: 'Definitions Repository',
    detail: 'The definitions Repository accepts no Run.',
    extensions: { refused: 'run' },
  });
}

/** 404 for a name that is neither a built-in agent nor a folder at the last fetched commit. */
export function agentNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: AGENTS_PROBLEM_TYPES.agentNotFound,
    title: 'Agent not found',
    detail: 'No agent has this name.',
  });
}

/** 404 for a path that is no regular file at the commit, or when there is no commit to read. */
export function agentFileNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: AGENTS_PROBLEM_TYPES.agentFileNotFound,
    title: 'File not found',
    detail: 'The definitions Repository has no regular file at this path.',
  });
}

/** 404 for a commit the Clone of the definitions Repository does not hold. */
export function agentCommitNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: AGENTS_PROBLEM_TYPES.agentCommitNotFound,
    title: 'Commit not found',
    detail: 'The Clone of the definitions Repository does not hold this commit.',
  });
}

/** 503 when the Clone cannot be read here (the API is not on Linux, or Git failed). */
export function agentFilesUnreadable(): ProblemException {
  return new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, {
    type: AGENTS_PROBLEM_TYPES.agentFilesUnreadable,
    title: 'Files cannot be read',
    detail: 'The Clone of the definitions Repository cannot be read now.',
  });
}

/** 422 for a file over the per-file limit; `size` and `limit` are bytes. */
export function draftFileTooLarge(size: number, limit: number): ProblemException {
  return new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
    type: AGENTS_PROBLEM_TYPES.draftFileTooLarge,
    title: 'File too large',
    detail: `The file is ${size} bytes; a file of the Draft may be at most ${limit} bytes.`,
    extensions: { size, limit },
  });
}

/** 422 for a change that takes the whole Draft over its total size; `size` and `limit` are bytes. */
export function draftTooLarge(size: number, limit: number): ProblemException {
  return new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
    type: AGENTS_PROBLEM_TYPES.draftTooLarge,
    title: 'Draft too large',
    detail: `The Draft would hold ${size} bytes; it may hold at most ${limit} bytes.`,
    extensions: { size, limit },
  });
}

/** 422 for a change that makes the Draft hold more changed files than the limit. */
export function draftTooManyFiles(limit: number): ProblemException {
  return new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
    type: AGENTS_PROBLEM_TYPES.draftTooManyFiles,
    title: 'Too many changed files',
    detail: `The Draft may change at most ${limit} files.`,
    extensions: { limit },
  });
}

/** 422 for a path that is a symbolic link or a submodule at the base commit. */
export function draftPathNotWritable(): ProblemException {
  return new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
    type: AGENTS_PROBLEM_TYPES.draftPathNotWritable,
    title: 'Path cannot be changed',
    detail: 'The path is a symbolic link or a submodule at the base commit.',
  });
}

/** 422 for a move onto a path where a file already is. */
export function draftPathTaken(): ProblemException {
  return new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
    type: AGENTS_PROBLEM_TYPES.draftPathTaken,
    title: 'Path taken',
    detail: 'A file already exists at the new path.',
  });
}

/** 422 for a path that would be a file where a folder is, or a folder where a file is. */
export function draftPathConflict(): ProblemException {
  return new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
    type: AGENTS_PROBLEM_TYPES.draftPathConflict,
    title: 'Path conflict',
    detail: 'The path would be both a file and a folder.',
  });
}

/** 422 for a base file over the file limit, whose bytes Studio does not carry to a new path. */
export function draftMoveUnsupported(): ProblemException {
  return new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
    type: AGENTS_PROBLEM_TYPES.draftMoveUnsupported,
    title: 'File cannot be moved',
    detail: 'A file over the file limit cannot be moved in the Draft.',
  });
}

/** 409 when the Repository has no commit to start a Draft from. */
export function draftNoBase(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: AGENTS_PROBLEM_TYPES.draftNoBase,
    title: 'No commit to base a Draft on',
    detail: 'The definitions Repository has no fetched commit yet.',
  });
}

/** 409 when other writes kept changing the Draft and every attempt of this one lost the race. */
export function draftConflict(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: AGENTS_PROBLEM_TYPES.draftConflict,
    title: 'Draft changed',
    detail: 'The Draft was changed by another write while this change was being made. Try again.',
  });
}

/** 409 when the commit the Draft began from is gone from the Clone: the Draft can only be discarded. */
export function draftBaseMissing(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: AGENTS_PROBLEM_TYPES.draftBaseMissing,
    title: 'Draft base is gone',
    detail:
      'The commit the Draft began from is gone from the Clone. Discard the Draft or apply its changes again.',
  });
}

/** 503 while the commit identity settings are not set: Studio will not commit as nobody. */
export function publishNotConfigured(): ProblemException {
  return new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, {
    type: AGENTS_PROBLEM_TYPES.publishNotConfigured,
    title: 'Publishing is not configured',
    detail:
      'Set STUDIO_DEFINITIONS_COMMIT_NAME and STUDIO_DEFINITIONS_COMMIT_EMAIL so that Studio can author the commit.',
  });
}

/** 409 while another publish holds the lock. */
export function publishRunning(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: AGENTS_PROBLEM_TYPES.publishRunning,
    title: 'A publish is running',
    detail: 'Another publish is running. Wait for it to end, then try again.',
  });
}

/** 409 when the Draft changes no file, or leaves the tree as the base has it. */
export function nothingToPublish(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: AGENTS_PROBLEM_TYPES.nothingToPublish,
    title: 'Nothing to publish',
    detail: 'The Draft changes nothing in the Repository.',
  });
}

/** 409 when the Repository holds another commit than the one the Draft began from, or the push was not a fast-forward. */
export function repositoryMoved(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: AGENTS_PROBLEM_TYPES.repositoryMoved,
    title: 'The Repository moved on',
    detail:
      'The definitions Repository holds a newer commit than the one the Draft began from. Fetch it, review what changed, and publish again.',
  });
}

/** 409 when the Git host refused the write; the Draft is kept. */
export function writeRefused(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: AGENTS_PROBLEM_TYPES.writeRefused,
    title: 'The Git host refused the write',
    detail:
      'The Git host refused the push. Give the Deploy key of the definitions Repository write access on the Git host, and check that its branch accepts a push from it. The Draft is kept.',
  });
}

/** 422 while the Draft has any problem: each one is listed. */
export function publishProblems(
  problems: readonly {
    agent: string;
    code: string;
    path: string;
    key: string | null;
    message: string;
  }[],
): ProblemException {
  return new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
    type: AGENTS_PROBLEM_TYPES.publishProblems,
    title: 'The Draft has problems',
    detail: 'Fix every problem of the Draft before publishing it.',
    extensions: {
      problems: problems.map(({ agent, code, path, key, message }) => ({
        agent,
        code,
        path,
        key,
        message,
      })),
    },
  });
}

/** 502 when the push failed for a reason that is not the Draft's: the host or the network. The Draft is kept. */
export function publishFailed(): ProblemException {
  return new ProblemException(HttpStatus.BAD_GATEWAY, {
    type: AGENTS_PROBLEM_TYPES.publishFailed,
    title: 'The publish failed',
    detail: 'The push to the Git host failed. The Draft is kept; try again later.',
  });
}
