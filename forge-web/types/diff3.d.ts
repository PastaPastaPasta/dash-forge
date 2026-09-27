/** diff3@0.0.3 (isomorphic-git's line merge), typed for the merge driver in `lib/merge/engine`. */
declare module 'diff3' {
  export type Diff3Block =
    | { readonly ok: readonly string[]; readonly conflict?: undefined }
    | { readonly ok?: undefined; readonly conflict: { readonly a: readonly string[]; readonly o: readonly string[]; readonly b: readonly string[] } }
  export default function diff3Merge(a: readonly string[], o: readonly string[], b: readonly string[]): Diff3Block[]
}
