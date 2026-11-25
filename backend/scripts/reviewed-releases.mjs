import { readFile, readdir } from 'node:fs/promises';

export async function loadReviewedReleases(directory = new URL('../../research/', import.meta.url)) {
  const names = (await readdir(directory))
    .filter(name => /^reviewed-official-releases-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  if (!names.length) throw new Error('Reviewed release files are missing');
  const releases = await Promise.all(names.map(async name => {
    const data = JSON.parse((await readFile(new URL(name, directory), 'utf8')).replace(/^\uFEFF/, ''));
    if (!Array.isArray(data?.articles) || !Array.isArray(data.timelineUpdates)) {
      throw new Error('Invalid reviewed release data in ' + name);
    }
    return data;
  }));
  return {
    articles: releases.flatMap(release => release.articles),
    timelineUpdates: releases.flatMap(release => release.timelineUpdates)
  };
}
