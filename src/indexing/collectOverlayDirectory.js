import fs from "node:fs/promises";
import path from "node:path";

/**
 * Every file under a directory, addressed by its path relative to it, as the
 * import entries an overlay is written from.
 *
 * The files sit directly under the root, laid out by logical path:
 * `<root>/dx9/model/x.dds` becomes `res:/dx9/model/x.dds`. Dot entries are
 * editor and VCS noise and are skipped. Shared by `cjs-overlay-import` and the
 * service's `POST /v1/overlays/revise`, so a hand import and a revise read a
 * directory the same way.
 *
 * @param {string} root The directory to walk.
 * @returns {Promise<Array<{ logicalPath: string, location: string, byteLength: number }>>}
 *   The entries, sorted by logical path.
 */
export async function collectOverlayDirectory(root)
{
    const entries = [];

    const Walk = async (current) =>
    {
        for (const item of await fs.readdir(current, { withFileTypes: true }))
        {
            if (item.name.startsWith(".")) continue;

            const full = path.join(current, item.name);

            if (item.isDirectory())
            {
                await Walk(full);
                continue;
            }

            const location = path.relative(root, full).split(path.sep).join("/");
            const stat = await fs.stat(full);

            entries.push({
                // Lower cased because the source mixes case freely and the
                // resource layer addresses in lower case; an overlay recorded
                // under a capitalised path silently never matches.
                logicalPath: `res:/${location}`.toLowerCase(),
                location,
                byteLength: stat.size,
            });
        }
    };

    await Walk(root);
    entries.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));

    return entries;
}
