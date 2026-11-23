/** Every reason a Compose file is refused. Each code has at least one failing fixture. */
export const REFUSAL_CODES = [
  'text_too_large',
  'too_many_services',
  'yaml_syntax',
  'custom_tag',
  'not_a_mapping',
  'duplicate_key',
  'alias_limit',
  'unjudgeable',
  'unknown_key',
  'invalid_value',
  'interpolation',
  'privileged',
  'host_namespace',
  'capability_added',
  'device',
  'mount_outside_source',
  'docker_socket',
  'external_network',
  'external_volume',
  'path_outside_source',
  'entry_service_missing',
  'entry_port_invalid',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface Refusal {
  code: RefusalCode;
  /** A path into the document, for example `services.web.volumes[1]`. */
  place: string;
  /** Where the parser knows it (1-based); absent for content that came from an alias or merge. */
  line?: number;
  /** Fixed wording per code. It never contains a value from the file. */
  message: string;
}

export const REFUSAL_MESSAGES: Record<RefusalCode, string> = {
  text_too_large: 'The Compose file is larger than the size limit.',
  too_many_services: 'The Compose file defines more services than the limit.',
  yaml_syntax: 'The Compose file is not valid YAML.',
  custom_tag: 'YAML custom tags are not allowed.',
  not_a_mapping: 'The Compose file must be a single YAML document holding one mapping.',
  duplicate_key: 'A key appears twice in the same mapping.',
  alias_limit: 'The file expands YAML aliases beyond the limit.',
  unjudgeable: 'The file could not be judged, so it is refused.',
  unknown_key: 'This key is not on the list of known Compose keys, or its value is not allowed.',
  invalid_value: 'This value has a shape the validation does not accept.',
  interpolation:
    'Variable interpolation is not allowed here: the value would only be known at start.',
  privileged: 'A privileged container is not allowed.',
  host_namespace: 'Sharing a host namespace (network, process or IPC) is not allowed.',
  capability_added: 'Adding a Linux capability is not allowed.',
  device: 'Giving a container a host device is not allowed.',
  mount_outside_source: 'A bind mount must stay inside the source directory.',
  docker_socket: 'Mounting a Docker socket is not allowed.',
  external_network: 'An external network is not allowed.',
  external_volume: 'An external volume is not allowed.',
  path_outside_source: 'A path must stay inside the source directory.',
  entry_service_missing: 'The chosen entry service does not exist in the Compose file.',
  entry_port_invalid: 'The chosen entry port is not a valid port number.',
};
