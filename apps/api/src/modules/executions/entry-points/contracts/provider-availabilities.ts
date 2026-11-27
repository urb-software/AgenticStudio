import { Injectable } from '@nestjs/common';
import type { ProviderAvailabilities, ProviderAvailabilityView } from '../../contracts/index.js';
import { ListProvidersHandler } from '../../application/features/list-providers/handler.js';

/** The driving adapter of {@link ProviderAvailabilities}: the providers list, without models. */
@Injectable()
export class ListProvidersProviderAvailabilities implements ProviderAvailabilities {
  constructor(private readonly handler: ListProvidersHandler) {}

  async list(): Promise<ProviderAvailabilityView[]> {
    const listed = await this.handler.execute();
    return listed.map(({ id, name, available, reason }) => ({
      id,
      name,
      available,
      ...(reason === undefined ? {} : { reason }),
    }));
  }
}
