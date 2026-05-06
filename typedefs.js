/**
 * @typedef {Object} ExecuteRequest
 * @property {string} [session_id] - Optional session ID for the execution
 * @property {string} language - The programming language
 * @property {string} version - The version of the language
 * @property {Array<TFile>} [files] - Array of files to be executed
 * @property {string} [stdin] - Standard input for the program
 * @property {Array<string>} [args] - Command-line arguments for the program
 * @property {number} [compile_timeout] - Timeout for compilation in milliseconds
 * @property {number} [run_timeout] - Timeout for execution in milliseconds
 * @property {number} [compile_memory_limit] - Memory limit for compilation in bytes
 * @property {number} [run_memory_limit] - Memory limit for execution in bytes
 * @memberof typedefs
 */

/**
 * @typedef {Object} TFile
 * @property {string} name - The name of the file
 * @property {string} [id] - The ID of the file
 * @property {string} [session_id] - The session ID the file was generated from
 * @property {string} content - The content of the file
 * @property {('base64'|'hex'|'utf8')} encoding - The encoding of the file content
 * @memberof typedefs
 */
