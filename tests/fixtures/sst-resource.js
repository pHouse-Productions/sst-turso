// Stand-in for sst/resource: throws for unlinked names, like SST does.
export const linked = {};
export const Resource = new Proxy(linked, {
  get(target, prop) {
    if (prop in target) return target[prop];
    throw new Error(`"${String(prop)}" is not linked`);
  },
});
