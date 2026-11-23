import { savePreviewSettingsRequestSchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class SavePreviewSettingsRequestDto extends createZodDto(
  savePreviewSettingsRequestSchema.meta({ id: 'SavePreviewSettingsRequest' }),
) {}
