/**
 * Reserved response header: only the kernel's pre-pipeline shutdown answer sets
 * it. With UNPROCESSED_SHUTDOWN it means no request lifecycle hook, middleware
 * or handler ran; an error responder may format the answer. This guarantee
 * covers the Setu server, not work performed by an intervening proxy.
 *
 * An application that sets it claims the request was not processed, and a client that honours the marker may send that request again, independently of status.
 * Readers compare the value exactly; other values are reserved.
 *
 * @since 0.14.0
 */
export const UNPROCESSED_HEADER = 'x-setu-unprocessed';

/**
 * Reserved value for the kernel's pre-pipeline shutdown answer, independent of
 * its status. See UNPROCESSED_HEADER for the guarantee and the consequence of
 * application code setting this marker.
 *
 * @since 0.14.0
 */
export const UNPROCESSED_SHUTDOWN = 'shutdown';
