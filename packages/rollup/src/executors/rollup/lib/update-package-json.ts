import { basename, join, parse } from 'path';
import { writeJsonFile } from 'nx/src/utils/fileutils';
import { writeFileSync } from 'fs';
import { PackageJson } from 'nx/src/utils/package-json';
import { NormalizedRollupExecutorOptions } from './normalize';
import { stripIndents } from '@nx/devkit';

// TODO(jack): Use updatePackageJson from @nx/js instead.
export function updatePackageJson(
  options: NormalizedRollupExecutorOptions,
  packageJson: PackageJson
) {
  const hasEsmFormat = options.format.includes('esm');
  const hasCjsFormat = options.format.includes('cjs');

  if (options.generateExportsField) {
    packageJson.exports =
      typeof packageJson.exports === 'string' ? {} : { ...packageJson.exports };
    packageJson.exports['./package.json'] = './package.json';
  }

  if (hasEsmFormat) {
    const esmExports = getExports({
      ...options,
      fileExt: '.esm.js',
    });

    packageJson.module = esmExports['.'];

    if (!hasCjsFormat) {
      packageJson.type = 'module';
      packageJson.main ??= esmExports['.'];
    }

    if (options.generateExportsField) {
      for (const [exportEntry, filePath] of Object.entries(esmExports)) {
        packageJson.exports[exportEntry] = hasCjsFormat
          ? // If CJS format is used, make sure `import` (from Node) points to same instance of the package.
            // Otherwise, packages that are required to be singletons (like React, RxJS, etc.) will break.
            // Reserve `module` entry for bundlers to accommodate tree-shaking.
            { [hasCjsFormat ? 'module' : 'import']: filePath }
          : filePath;
      }
    }
  }

  if (hasCjsFormat) {
    const cjsExports = getExports({
      ...options,
      fileExt: '.cjs.js',
    });

    packageJson.main = cjsExports['.'];

    if (!hasEsmFormat) {
      packageJson.type = 'commonjs';
    }

    if (options.generateExportsField) {
      for (const [exportEntry, filePath] of Object.entries(cjsExports)) {
        if (hasEsmFormat) {
          // If ESM format used, make sure `import` (from Node) points to a wrapped
          // version of CJS file to ensure the package remains a singleton.
          // TODO(jack): This can be made into a rollup plugin to re-use in Vite.
          const relativeFile = parse(filePath).base;
          const fauxEsmFilePath = filePath.replace(/\.cjs\.js$/, '.cjs.mjs');
          packageJson.exports[exportEntry]['import'] ??= fauxEsmFilePath;
          packageJson.exports[exportEntry]['default'] ??= filePath;
          // Re-export from relative CJS file, and Node will synthetically export it as ESM.
          // Make sure both ESM and CJS point to same instance of the package because libs like React, RxJS, etc. requires it.
          // Also need a special .cjs.default.js file that re-exports the `default` from CJS, or else
          // default import in Node will not work.
          writeFileSync(
            join(
              options.outputPath,
              filePath.replace(/\.cjs\.js$/, '.cjs.default.js')
            ),
            `exports._default = require('./${parse(filePath).base}').default;`
          );
          writeFileSync(
            join(options.outputPath, fauxEsmFilePath),
            // Re-export from relative CJS file, and Node will synthetically export it as ESM.
            stripIndents`
            export * from './${relativeFile}';
            export { _default as default } from './${relativeFile.replace(
              /\.cjs\.js$/,
              '.cjs.default.js'
            )}';
            `
          );
        } else {
          packageJson.exports[exportEntry] = filePath;
        }
      }
    }
  }

  writeJsonFile(`${options.outputPath}/package.json`, packageJson);
}

interface Exports {
  '.': string;

  [name: string]: string;
}

function getExports(
  options: Pick<
    NormalizedRollupExecutorOptions,
    'main' | 'projectRoot' | 'outputFileName' | 'additionalEntryPoints'
  > & {
    fileExt: string;
  }
): Exports {
  const mainFile = options.outputFileName
    ? options.outputFileName.replace(/\.[tj]s$/, '')
    : basename(options.main).replace(/\.[tj]s$/, '');
  const exports: Exports = {
    '.': './' + mainFile + options.fileExt,
  };

  if (options.additionalEntryPoints) {
    for (const file of options.additionalEntryPoints) {
      const { name: fileName } = parse(file);
      exports['./' + fileName] = './' + fileName + options.fileExt;
    }
  }

  return exports;
}
