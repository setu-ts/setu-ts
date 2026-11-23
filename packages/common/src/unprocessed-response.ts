/**
 * Reserved response header. The kernel sets it only on its pre-pipeline shutdown
 * answer, and an application may also set it (see below). Set by the kernel
 * with UNPROCESSED_SHUTDOWN, it means no request lifecycle hook, middleware
 * or handler ran; an error responder may format the answer. This guarantee
 * covers the Setu server, not work performed by an intervening proxy.
 *
 * An application that sets it claims the request was not processed, and a
 * client that honours the marker may send that request again, whatever the
 * status.
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
