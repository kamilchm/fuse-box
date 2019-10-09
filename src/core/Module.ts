import * as buntis from 'buntis';
import * as meriyah from 'meriyah';
import * as sourceMapModule from 'source-map';
import { IModuleCacheBasics } from '../cache/cache';
import { ASTNode } from '../compiler/interfaces/AST';
import { ImportType } from '../compiler/interfaces/ImportType';
import { ITransformerResult } from '../compiler/interfaces/ITranformerResult';
import { javascriptTranspiler } from '../compiler/transpilers/javascriptTranspiler';
import { typescriptTranspiler } from '../compiler/transpilers/typescriptTranspiler';
import { testPath } from '../plugins/pluginUtils';
import { ProductionModule } from '../production/ProductionModule';
import { IStylesheetModuleResponse } from '../stylesheet/interfaces';
import { extractFuseBoxPath, fastHash, joinFuseBoxPath, readFile } from '../utils/utils';
import { Context } from './Context';
import { Package } from './Package';
import { generate } from '../compiler/generator/generator';
import * as ts from 'typescript';
const EXECUTABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

export interface IAnalysis {
  imports?: Array<{ type: ImportType; literal: string }>;
}

export interface IModuleProps {
  ctx: Context;
  absPath: string;
  fuseBoxPath: string;
  extension: string;
}
export class Module {
  /**
   * Meta will be store to cache if set
   *
   * @type {{ [key: string]: any }}
   * @memberof Module
   */
  public meta: { [key: string]: any };

  public isCached: boolean;
  public errored: boolean;
  public cache: IModuleCacheBasics;

  public assembled: boolean;
  public isEntryPoint?: boolean;

  public analysis: IAnalysis;

  public css: IStylesheetModuleResponse;
  public isCSSModule?: boolean;
  public isCSSText?: boolean;

  /**
   * A package that holds this module
   *
   * @type {Package}
   * @memberof Module
   */

  public pkg: Package;
  /**
   * A list of modules that imported this moudle
   *
   * @type {Array<Module>}
   * @memberof Module
   */
  public moduleDependants: Array<Module>;

  /**
   * Toggle this from plugins in order to let the watchers to break
   * all modules cache which imported this module
   *
   * @type {boolean}
   * @memberof Module
   */
  public breakDependantsCache: boolean;

  /**
   * Current dependency tree
   *
   * @type {Array<Module>}
   * @memberof Module
   */
  public moduleDependencies: Array<Module>;

  /**
   * Node Modules dependencies of this module
   *
   * @type {Array<Package>}
   * @memberof Module
   */
  public externalDependencies: Array<Package>;

  /**
   * Used by plugins to identify whether this module has been captured
   * And prevent other plugins from capturing it
   *
   * @type {boolean}
   * @memberof Module
   */
  public captured: boolean;

  /*  Properties that affect bundle result  */

  public header: Array<string>; // extra content on top of the file
  public contents: string; // primary contents
  public sourceMap: string; // primary sourcemap
  public cssSourceMap: string; // css sourcemap
  public weakReferences: Array<string>;
  public ast?: ASTNode;

  private _isStylesheet: boolean;
  private _isExecutable: boolean;
  private _isJavascriptModule: boolean;

  public productionModule: ProductionModule;

  constructor(public props: IModuleProps, pkg: Package) {
    this.pkg = pkg;
    this.assembled = false;
    this.header = [];
    this.moduleDependencies = [];
    this.externalDependencies = [];
  }

  public isEntry() {
    return this.pkg.entry === this;
  }

  public isTypescriptModule(): boolean {
    return ['.ts', '.tsx'].includes(this.props.extension);
  }

  public isJavascriptModule() {
    if (this._isJavascriptModule !== undefined) return this._isJavascriptModule;
    this._isJavascriptModule = ['.js', '.jsx', '.mjs'].indexOf(this.props.extension) > -1;
    return this._isJavascriptModule;
  }

  public parse(): ASTNode {
    const withSourcemaps = this.isSourceMapRequired();
    if (!this.isJavascriptModule()) {
      this.ast = buntis.parseTSModule(this.contents, {
        directives: true,
        jsx: true,
        next: true,
        loc: withSourcemaps,
      }) as ASTNode;
    } else {
      let opts = { jsx: true, next: false, module: true, loc: withSourcemaps };
      this.ast = meriyah.parse(this.contents, opts) as ASTNode;
      return this.ast;
    }
  }

  public transpile() {
    const config = this.props.ctx.config;
    const options = {
      ast: this.ast,
      env: config.env,
      isBrowser: config.target !== 'server',
      isServer: config.target === 'server',
      moduleFileName: this.props.fuseBoxPath,
      target: config.target,
    };
    let result: ITransformerResult;
    if (this.isJavascriptModule()) {
      result = javascriptTranspiler(options);
    } else {
      result = typescriptTranspiler(options);
    }
    return result;
  }

  public setMeta(key: string, value: any) {
    this.meta = this.meta || {};
    this.meta[key] = value;
  }

  public getMeta(key: string) {
    if (this.meta && this.meta[key]) {
      return this.meta[key];
    }
  }

  public addWeakReference(url: string) {
    if (url === this.props.absPath) return;
    if (!this.weakReferences) this.weakReferences = [];
    if (!this.weakReferences.includes(url)) {
      this.weakReferences.push(url);
      this.props.ctx.weakReferences.add(url, this.props.absPath);
    }
  }

  public testPath(path: string | RegExp) {
    return testPath(this.props.absPath, path);
  }

  public setCache(basics: IModuleCacheBasics) {
    this.isCached = true;
    this.cache = basics;
  }

  public getSourceMapPath() {
    const config = this.props.ctx.config;
    if (this.props.ctx.config.isServer()) {
      return this.props.absPath;
    }
    if (this.pkg.isDefaultPackage) {
      return joinFuseBoxPath(
        config.sourceMap.sourceRoot,
        extractFuseBoxPath(this.props.ctx.config.homeDir, this.props.absPath),
      );
    } else {
      return joinFuseBoxPath(
        config.defaultSourceMapModulesRoot,
        this.pkg.getPublicName(),
        extractFuseBoxPath(this.pkg.props.meta.packageRoot, this.props.absPath),
      );
    }
  }

  public read(forceReload?: boolean): string {
    if (this.contents === undefined || forceReload) {
      this.contents = readFile(this.props.absPath);
    }
    return this.contents;
  }

  public makeExecutable() {
    this._isExecutable = true;
  }

  public isExecutable() {
    if (this._isExecutable === undefined) {
      this._isExecutable = EXECUTABLE_EXTENSIONS.includes(this.props.extension);
    }
    return this._isExecutable;
  }

  public isStylesheet() {
    if (this._isStylesheet === undefined) {
      this._isStylesheet = ['.css', '.scss', '.sass', '.less', '.styl'].indexOf(this.props.extension) > -1;
    }
    return this._isStylesheet;
  }

  public notStylesheet() {
    this._isStylesheet = false;
  }

  public getShortPath() {
    return `${this.pkg.getPublicName()}/${this.props.fuseBoxPath}`;
  }

  public getHasedPath() {
    return fastHash(`${this.pkg.getPublicName()}/${this.props.fuseBoxPath}`);
  }
  public isCSSSourceMapRequired() {
    let requireSourceMap = true;
    const config = this.props.ctx.config;
    if (config.sourceMap.css === false) {
      requireSourceMap = false;
    }
    if (!this.pkg.isDefaultPackage && !config.sourceMap.vendor) {
      requireSourceMap = false;
    }
    return requireSourceMap;
  }
  public isSourceMapRequired() {
    let requireSourceMaps = true;
    const config = this.props.ctx.config;
    if (this.pkg.isDefaultPackage) {
      if (!config.sourceMap.project) {
        requireSourceMaps = false;
      }
    } else {
      if (!config.sourceMap.vendor) {
        requireSourceMaps = false;
      }
    }
    return requireSourceMaps;
  }

  public generateCode() {
    // if (this.props.extension === '.ts') {
    //   const compilerOptions: ts.CompilerOptions = {
    //     module: ts.ModuleKind.CommonJS,
    //     experimentalDecorators: true,
    //   };
    //   const data = ts.transpileModule(this.contents, {
    //     fileName: this.props.absPath,
    //     compilerOptions,
    //   });
    //   this.contents = data.outputText;
    //   console.log('here...');
    //   return;
    // }
    if (this.ast) {
      const withSourcemaps = this.isSourceMapRequired();
      let map;
      if (withSourcemaps) {
        map = new sourceMapModule.SourceMapGenerator({
          file: 'script.js',
        });
      }
      let code;
      try {
        code = generate(this.ast, { ecmaVersion: 7, sourceMap: map /*lineEnd: '', indent: ''*/ });
      } catch (e) {
        this.props.ctx.log.clearConsole();
        this.props.ctx.fatal('Error when genering the code from AST', [e.stack, `In file ${this.props.absPath}`]);
      }
      let jsonSourceMaps;

      if (withSourcemaps) {
        jsonSourceMaps = map.toJSON();
        if (!jsonSourceMaps.sourcesContent) {
          delete jsonSourceMaps.file;
          jsonSourceMaps.sources = [this.getSourceMapPath()];
          jsonSourceMaps.sourcesContent = [this.contents];
        }
      }
      this.contents = code;
      this.sourceMap = JSON.stringify(jsonSourceMaps);
    }
  }

  public generate() {
    return {
      contents: this.contents,
      sourceMap: this.sourceMap,
    };
  }
}

export function createModule(props: IModuleProps, pkg: Package) {
  return new Module(props, pkg);
}
