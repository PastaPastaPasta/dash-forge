/**
 * The IPFS variant's base path rule, in one place: next.config.js reads it for the client's
 * router base path and webpack public path, scripts/ipfs-postbuild.mjs for the <base> every page
 * sets. The base path is `/ipfs/<cid>` or `/ipns/<name>` on a path gateway, '' anywhere else.
 */

/** Regular expression source matching the base path at the start of a URL's path. */
exports.IPFS_BASE_PATH = String.raw`^\/ip[fn]s\/[^/]+`
