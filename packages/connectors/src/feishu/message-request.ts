import { FeishuDeliveryError } from "@shared/feishu-delivery-error.js";
import { feishuResponseError, feishuTransportError } from "./native-cot.js";

/** Only a create/reply request can have an uncertain send outcome. */
export async function feishuMessageRequest<T extends { code?: number; data?: { message_id?: string } }>(
  operation: string, request: () => Promise<T>,
): Promise<T> {
  let response: T;
  try { response = await request(); }
  catch (error) { throw feishuTransportError(operation, error); }
  if (response.code !== 0) throw feishuResponseError(operation, response);
  if (!response.data?.message_id || response.data.message_id === "unknown") {
    throw new FeishuDeliveryError(`${operation}: acknowledgement missing`, true, true);
  }
  return response;
}
