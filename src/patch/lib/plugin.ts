/*
 * The logic in this file is based on TTypescript (https://github.com/cevek/ttypescript)
 * Credit & thanks go to cevek (https://github.com/cevek) for the incredible work!
 */
import * as TS from 'typescript';
import {
  Bundle, CustomTransformers, LanguageService, Program, SourceFile, TransformationContext, TransformerFactory
} from 'typescript';
import resolve from 'resolve';
import { diagnosticExtrasFactory, getCurrentLibrary } from './shared';
import {
  CompilerOptionsPattern, ConfigPattern, LSPattern, PluginConfig, PluginFactory, ProgramPattern, ProgramTransformer,
  RawPattern, TransformerBasePlugin, TransformerList, TransformerPlugin, TypeCheckerPattern
} from '../../installer';
import * as TSPlus from './type-declarations';
import fs from 'fs';
import path from 'path';


/* ****************************************************************************************************************** */
// region: Module Vars & Ambients
/* ****************************************************************************************************************** */

let tsNodeIncluded = false;
const requireStack: string[] = [];

declare const ts: typeof TS & typeof TSPlus;

// endregion


/* ****************************************************************************************************************** */
// region: PluginCreator
/* ****************************************************************************************************************** */

/**
 * @example
 *
 * new PluginCreator([
 *   {transform: '@zerollup/ts-transform-paths', someOption: '123'},
 *   {transform: '@zerollup/ts-transform-paths', type: 'ls', someOption: '123'},
 *   {transform: '@zerollup/ts-transform-paths', type: 'ls', after: true, someOption: '123'}
 * ]).createTransformers({ program })
 */
export class PluginCreator {
  currentProject?: string

  constructor(
    private configs: PluginConfig[],
    private resolveBaseDir: string = process.cwd()
  ) {
    PluginCreator.validateConfigs(configs);

    // Support for deprecated 1.1 name
    for (const config of configs) if (config['beforeEmit']) config.transformProgram = true;
  }

  public mergeTransformers(into: TransformerList, source: CustomTransformers | TransformerBasePlugin) {
    const slice = <T>(input: T | T[]) => (Array.isArray(input) ? input.slice() : [ input ]);

    if (source.before) into.before.push(...slice(source.before));
    if (source.after) into.after.push(...slice(source.after));
    if (source.afterDeclarations) into.afterDeclarations.push(...slice(source.afterDeclarations));

    return this;
  }

  public createTransformers(
    params: { program: Program } | { ls: LanguageService },
    customTransformers?: CustomTransformers
  ): TransformerList {
    const transformers: TransformerList = { before: [], after: [], afterDeclarations: [] };

    const [ ls, program ] = ('ls' in params) ? [ params.ls, params.ls.getProgram()! ] : [ void 0, params.program ];

    for (const config of this.configs) {
      if (!config.transform || config.transformProgram) continue;

      const factory = this.resolveFactory(config);
      if (factory === undefined) continue;

      this.mergeTransformers(
        transformers,
        PluginCreator.createTransformerFromPattern({ factory: <PluginFactory>factory, config, program, ls })
      );
    }

    // Chain custom transformers at the end
    if (customTransformers) this.mergeTransformers(transformers, customTransformers);

    return transformers;
  }

  public getProgramTransformers(): [ ProgramTransformer, PluginConfig ][] {
    const res: [ ProgramTransformer, PluginConfig ][] = [];
    for (const config of this.configs) {
      if (!config.transform || !config.transformProgram) continue;

      const factory = this.resolveFactory(config) as ProgramTransformer;
      if (factory === undefined) continue;

      res.push([ factory, config ]);
    }

    return res;
  }


  /* ***********************************************************
   * Helpers
   * ***********************************************************/

  private resolveFactory(config: PluginConfig): PluginFactory | ProgramTransformer | undefined {
    let { tsConfig } = config;
    const transform = config.transform!;
    const importKey = config.import || 'default';

    /* Add support for TS transformers */
    let tsConfigCleanup: Function | undefined;
    if (transform!.match(/\.ts$/)) {
      // If tsConfig is specified and it differs, we need to re-register tsNode
      if (tsNodeIncluded && (tsConfig !== this.currentProject)) tsNodeIncluded = false;
      if (tsConfig) tsConfig = path.resolve(this.resolveBaseDir, tsConfig);
      this.currentProject = tsConfig;

      if (!tsNodeIncluded) {
        /* Try to add path mapping support, if paths specified */
        let tsConfigData: any;
        try { tsConfigData = tsConfig && JSON.parse(fs.readFileSync(tsConfig, 'utf8')); } catch {}
        if (tsConfig && tsConfigData?.compilerOptions?.paths) {
          try {
            const tsConfigPaths = require('tsconfig-paths');
            const { absoluteBaseUrl } = tsConfigPaths.loadConfig(tsConfig);
            tsConfigCleanup = tsConfigPaths.register({
              baseUrl: absoluteBaseUrl,
              paths: tsConfigData.compilerOptions.paths
            });
          }
          catch (e) {
            if (e.code === 'MODULE_NOT_FOUND')
              console.warn(
              `Warning: Paths specified in transformer tsconfig.json, but they can't be resolved. ` +
              `Try adding 'tsconfig-paths' as a dev dependency`
              );
            else throw e;
          }
        }

        /* Register tsNode */
        require('ts-node').register({
          transpileOnly: true,
          ...(tsConfig ? { project: tsConfig } : { skipProject: true }),
          compilerOptions: {
            target: 'ES2018',
            jsx: 'react',
            esModuleInterop: true,
            module: 'commonjs',
          }
        });
        tsNodeIncluded = true;
      }
    }

    const modulePath = resolve.sync(transform, { basedir: this.resolveBaseDir });

    /* Prevent recursive requiring of createTransformers (issue with ts-node) */
    if (requireStack.indexOf(modulePath) > -1) return;

    /* Load plugin */
    requireStack.push(modulePath);
    const commonjsModule: PluginFactory | { [key: string]: PluginFactory } = require(modulePath);
    requireStack.pop();

    // Un-register path mapping if in place
    tsConfigCleanup?.();

    const factoryModule = (typeof commonjsModule === 'function') ? { default: commonjsModule } : commonjsModule;
    const factory = factoryModule[importKey];

    if (!factory)
      throw new Error(
        `tsconfig.json > plugins: "${transform}" does not have an export "${importKey}": ` +
        require('util').inspect(factoryModule)
      );

    if (typeof factory !== 'function') {
      throw new Error(
        `tsconfig.json > plugins: "${transform}" export "${importKey}" is not a plugin: ` +
        require('util').inspect(factory)
      );
    }

    return factory;
  }

  static validateConfigs(configs: PluginConfig[]) {
    for (const config of configs)
      if (!config.name && !config.transform) throw new Error('tsconfig.json plugins error: transform must be present');
  }

  static createTransformerFromPattern({ factory, config, program, ls }: {
    factory: PluginFactory;
    config: PluginConfig;
    program: Program;
    ls?: LanguageService;
  }):
    TransformerBasePlugin {
    const { transform, after, afterDeclarations, name, type, transformProgram, ...cleanConfig } = config;

    if (!transform) throw new Error('Not a valid config entry: "transform" key not found');

    let ret: TransformerPlugin;
    switch (config.type) {
      case 'ls':
        if (!ls) throw new Error(`Plugin ${transform} needs a LanguageService`);
        ret = (factory as LSPattern)(ls, cleanConfig);
        break;

      case 'config':
        ret = (factory as ConfigPattern)(cleanConfig);
        break;

      case 'compilerOptions':
        ret = (factory as CompilerOptionsPattern)(program.getCompilerOptions(), cleanConfig);
        break;

      case 'checker':
        ret = (factory as TypeCheckerPattern)(program.getTypeChecker(), cleanConfig);
        break;

      case undefined:
      case 'program':
        const { addDiagnostic, removeDiagnostic, diagnostics } = diagnosticExtrasFactory(program);

        ret = (factory as ProgramPattern)(program, cleanConfig, {
          ts,
          addDiagnostic,
          removeDiagnostic,
          diagnostics,
          library: getCurrentLibrary()
        });
        break;

      case 'raw':
        ret = (ctx: TransformationContext) => (factory as RawPattern)(ctx, program, cleanConfig);
        break;

      default:
        throw new Error(`Invalid plugin type found in tsconfig.json: '${config.type}'`);
    }

    if (typeof ret === 'function')
      return after ? ({ after: ret }) :
             afterDeclarations ? ({ afterDeclarations: ret as TransformerFactory<SourceFile | Bundle> }) :
               { before: ret };

    return ret;
  }
}

// endregion
