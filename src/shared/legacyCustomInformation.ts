import type { CustomInformation } from './types.ts';

/** Keep earlier saved answers recognizable in the profile assistant. */
export function isMissingInformationRecord(record: CustomInformation): boolean {
  return record.id.startsWith('learned-');
}
