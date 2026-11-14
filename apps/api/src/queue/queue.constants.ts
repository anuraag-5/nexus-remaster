export const QUEUE_NAME_PREFIX = "nexus-checks";

export function getQueueName(regionCode: string): string {
  const normalizedRegionCode = regionCode.trim().toLowerCase();

  if (
    !normalizedRegionCode ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedRegionCode)
  ) {
    throw new Error(`Invalid region code: ${regionCode}`);
  }

  return `${QUEUE_NAME_PREFIX}-${normalizedRegionCode}`;
}
