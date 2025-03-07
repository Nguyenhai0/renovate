import url from 'url';
import is from '@sindresorhus/is';
import { logger } from '../../logger';
import { ExternalHostError } from '../../types/errors/external-host-error';
import * as packageCache from '../../util/cache/package';
import { Http, HttpOptions } from '../../util/http';
import { id } from './common';
import { resolvePackage } from './npmrc';
import type { NpmDependency, NpmRelease, NpmResponse } from './types';

const http = new Http(id);

let memcache: Record<string, string> = {};

export function resetMemCache(): void {
  logger.debug('resetMemCache()');
  memcache = {};
}

export function resetCache(): void {
  resetMemCache();
}

interface PackageSource {
  sourceUrl?: string;
  sourceDirectory?: string;
}

function getPackageSource(repository: any): PackageSource {
  const res: PackageSource = {};
  if (repository) {
    if (is.nonEmptyString(repository)) {
      res.sourceUrl = repository;
    } else if (is.nonEmptyString(repository.url)) {
      res.sourceUrl = repository.url;
    }
    if (is.nonEmptyString(repository.directory)) {
      res.sourceDirectory = repository.directory;
    }
    const sourceUrlCopy = `${res.sourceUrl}`;
    const sourceUrlSplit: string[] = sourceUrlCopy.split('/');
    if (sourceUrlSplit.length > 7 && sourceUrlSplit[2] === 'github.com') {
      // Massage the repository URL for non-compliant strings for github (see issue #4610)
      // Remove the non-compliant segments of path, so the URL looks like "<scheme>://<domain>/<vendor>/<repo>"
      // and add directory to the repository
      res.sourceUrl = sourceUrlSplit.slice(0, 5).join('/');
      res.sourceDirectory ||= sourceUrlSplit
        .slice(7, sourceUrlSplit.length)
        .join('/');
    }
  }
  return res;
}

export async function getDependency(
  packageName: string
): Promise<NpmDependency | null> {
  logger.trace(`npm.getDependency(${packageName})`);

  // This is our datastore cache and is cleared at the end of each repo, i.e. we never requery/revalidate during a "run"
  if (memcache[packageName]) {
    logger.trace('Returning cached result');
    return JSON.parse(memcache[packageName]) as NpmDependency;
  }

  const { headers, packageUrl, registryUrl } = resolvePackage(packageName);

  // Now check the persistent cache
  const cacheNamespace = 'datasource-npm';
  const cachedResult = await packageCache.get<NpmDependency>(
    cacheNamespace,
    packageUrl
  );
  // istanbul ignore if
  if (cachedResult) {
    return cachedResult;
  }

  const uri = url.parse(packageUrl);

  if (uri.host === 'registry.npmjs.org' && !uri.pathname.startsWith('/@')) {
    // Delete the authorization header for non-scoped public packages to improve http caching
    // Otherwise, authenticated requests are not cacheable until the registry adds "public" to Cache-Control
    // Ref: https://greenbytes.de/tech/webdav/rfc7234.html#caching.authenticated.responses
    delete headers.authorization;
  }

  try {
    const opts: HttpOptions = {
      headers,
    };
    const raw = await http.getJson<NpmResponse>(packageUrl, opts);
    const res = raw.body;
    if (!res.versions || !Object.keys(res.versions).length) {
      // Registry returned a 200 OK but with no versions
      logger.debug({ dependency: packageName }, 'No versions returned');
      return null;
    }

    const latestVersion = res.versions[res['dist-tags'].latest];
    res.repository = res.repository || latestVersion.repository;
    res.homepage = res.homepage || latestVersion.homepage;

    const { sourceUrl, sourceDirectory } = getPackageSource(res.repository);

    // Simplify response before caching and returning
    const dep: NpmDependency = {
      name: res.name,
      homepage: res.homepage,
      sourceUrl,
      sourceDirectory,
      versions: {},
      releases: null,
      'dist-tags': res['dist-tags'],
      registryUrl,
    };

    if (latestVersion.deprecated) {
      dep.deprecationMessage = `On registry \`${registryUrl}\`, the "latest" version of dependency \`${packageName}\` has the following deprecation notice:\n\n\`${latestVersion.deprecated}\`\n\nMarking the latest version of an npm package as deprecated results in the entire package being considered deprecated, so contact the package author you think this is a mistake.`;
      dep.deprecationSource = id;
    }
    dep.releases = Object.keys(res.versions).map((version) => {
      const release: NpmRelease = {
        version,
        gitRef: res.versions[version].gitHead,
        dependencies: res.versions[version].dependencies,
        devDependencies: res.versions[version].devDependencies,
      };
      if (res.time?.[version]) {
        release.releaseTimestamp = res.time[version];
      }
      if (res.versions[version].deprecated) {
        release.isDeprecated = true;
      }
      const source = getPackageSource(res.versions[version].repository);
      if (source.sourceUrl && source.sourceUrl !== dep.sourceUrl) {
        release.sourceUrl = source.sourceUrl;
      }
      if (
        source.sourceDirectory &&
        source.sourceDirectory !== dep.sourceDirectory
      ) {
        release.sourceDirectory = source.sourceDirectory;
      }
      return release;
    });
    logger.trace({ dep }, 'dep');
    // serialize first before saving
    memcache[packageName] = JSON.stringify(dep);
    const cacheMinutes = process.env.RENOVATE_CACHE_NPM_MINUTES
      ? parseInt(process.env.RENOVATE_CACHE_NPM_MINUTES, 10)
      : 15;
    // TODO: use dynamic detection of public repos instead of a static list (#9587)
    const whitelistedPublicScopes = [
      '@graphql-codegen',
      '@storybook',
      '@types',
      '@typescript-eslint',
    ];
    if (
      !raw.authorization &&
      (whitelistedPublicScopes.includes(packageName.split('/')[0]) ||
        !packageName.startsWith('@'))
    ) {
      await packageCache.set(cacheNamespace, packageUrl, dep, cacheMinutes);
    }
    return dep;
  } catch (err) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      logger.debug(
        {
          packageUrl,
          err,
          statusCode: err.statusCode,
          packageName,
        },
        `Dependency lookup failure: unauthorized`
      );
      return null;
    }
    if (err.statusCode === 402) {
      logger.debug(
        {
          packageUrl,
          err,
          statusCode: err.statusCode,
          packageName,
        },
        `Dependency lookup failure: payent required`
      );
      return null;
    }
    if (err.statusCode === 404 || err.code === 'ENOTFOUND') {
      logger.debug(
        { err, packageName },
        `Dependency lookup failure: not found`
      );
      return null;
    }
    if (uri.host === 'registry.npmjs.org') {
      // istanbul ignore if
      if (err.name === 'ParseError' && err.body) {
        err.body = 'err.body deleted by Renovate';
      }
      throw new ExternalHostError(err);
    }
    return null;
  }
}
