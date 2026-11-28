// SOURCING: Pyodide runs the code: loadPackagesFromImports and micropip load
// what it imports, pyodide.code.eval_code_async runs it and gives back its last
// expression, pyodide-http routes requests and urllib through the browser, and
// matplotlib's Agg backend draws its figures. What a run hands back, and how
// much of it, is this app's.
import type { PyodideAPI } from 'pyodide'

/** Where Pyodide's runtime and packages are served from, for a loader version. */
export const pyodideIndexURL = (version: string) =>
  `https://cdn.jsdelivr.net/pyodide/v${version}/full/`

/**
 * How much of a run's own output is handed back. A receipt is at most 2 MiB
 * and a turn is shown at most four pictures a step, each at most 2 MiB.
 */
export const RUN_LIMITS = {
  value: 32_000,
  fileText: 64_000,
  figures: 4,
  figureBase64: 1_400_000,
} as const

/** What the agent asks to run. */
export interface PythonRequest {
  code: string
  /** Installed with micropip before the run, beyond what the imports load. */
  packages?: string[]
  /** Text files written to the working directory before the run. */
  files?: Record<string, string>
  /** Runs naming the same session share their variables and directory. */
  session?: string
}

/** A figure, in the shape a turn takes a picture out of a result by. */
export interface PythonPicture {
  type: 'image'
  mediaType: 'image/png'
  data: string
  width: number
  height: number
}

/** A file the run wrote or changed, with its text when it is small text. */
export interface PythonFile {
  name: string
  bytes: number
  text?: string
}

/** What the run itself produced, apart from its output streams. */
export interface PythonRunResult {
  value?: { json: unknown } | { repr: string; truncatedFrom?: number }
  /** The traceback, from the run's own code down, when it raised. */
  error?: string
  figures: PythonPicture[]
  figuresLeftOut?: number
  files: PythonFile[]
  /** Packages this run loaded that earlier runs had not. */
  loaded: string[]
}

export type PythonStream = 'stdout' | 'stderr'

/**
 * The Python side of a run. Each run gets a fresh `__main__` namespace and
 * directory unless it names a session; figures still open at the end are
 * drawn and closed.
 */
const DRIVER = String.raw`
import base64, io, json, os, struct, sys, traceback
from pyodide.code import eval_code_async
import pyodide_http

os.environ.setdefault("MPLBACKEND", "Agg")
FILENAME = "<python.run>"
HOME = "/home/pyodide/theorem"
sessions = {}
runs = 0


def snapshot(root):
    found = {}
    for base, _, names in os.walk(root):
        for name in names:
            path = os.path.join(base, name)
            info = os.stat(path)
            found[os.path.relpath(path, root)] = (info.st_size, info.st_mtime_ns)
    return found


def describe(value, limit):
    if value is None:
        return None
    if type(value).__module__ == "numpy" and getattr(value, "size", limit) <= 10_000:
        value = value.tolist()
    try:
        if len(json.dumps(value, allow_nan=False)) <= limit:
            return {"json": value}
    except (TypeError, ValueError, OverflowError, RecursionError):
        pass
    text = repr(value)
    if len(text) <= limit:
        return {"repr": text}
    return {"repr": text[:limit], "truncatedFrom": len(text)}


def trace(error):
    frames = error.__traceback__
    while frames is not None and frames.tb_frame.f_code.co_filename != FILENAME:
        frames = frames.tb_next
    if frames is None:
        return "".join(traceback.format_exception_only(type(error), error))
    return "".join(traceback.format_exception(type(error), error, frames))


def figures(count, budget):
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return [], 0
    drawn, left = [], 0
    for number in plt.get_fignums():
        if len(drawn) >= count:
            left += 1
            continue
        figure = plt.figure(number)
        for dpi in (100, 72, 50):
            buffer = io.BytesIO()
            figure.savefig(buffer, format="png", dpi=dpi, bbox_inches="tight")
            png = buffer.getvalue()
            data = base64.b64encode(png).decode("ascii")
            if len(data) <= budget:
                break
        else:
            left += 1
            continue
        budget -= len(data)
        width, height = struct.unpack(">II", png[16:24])
        drawn.append({"type": "image", "mediaType": "image/png", "data": data,
                      "width": width, "height": height})
    plt.close("all")
    return drawn, left


def written(root, before, budget):
    found = []
    for name, stamp in sorted(snapshot(root).items()):
        if before.get(name) == stamp:
            continue
        entry = {"name": name, "bytes": stamp[0]}
        if stamp[0] <= budget:
            try:
                with open(os.path.join(root, name), encoding="utf-8") as file:
                    entry["text"] = file.read()
                budget -= len(entry["text"])
            except (UnicodeDecodeError, OSError):
                pass
        found.append(entry)
    return found


async def run(code, files, session, limits):
    global runs
    pyodide_http.patch_all()
    if session:
        root = os.path.join(HOME, "sessions", session)
        namespace = sessions.setdefault(session, {"__name__": "__main__"})
    else:
        runs += 1
        root = os.path.join(HOME, "runs", str(runs))
        namespace = {"__name__": "__main__"}
    os.makedirs(root, exist_ok=True)
    for name, text in files.items():
        path = os.path.normpath(os.path.join(root, name))
        if os.path.commonpath([root, path]) != root or path == root:
            raise ValueError(f"{name!r} is outside the run's directory; files paths are relative to it.")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as file:
            file.write(text)
    os.chdir(root)
    before = snapshot(root)
    result = {}
    try:
        value = await eval_code_async(code, namespace, filename=FILENAME)
        described = describe(value, limits["value"])
        if described is not None:
            result["value"] = described
    except BaseException as error:
        result["error"] = trace(error)
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
    try:
        result["figures"], left = figures(limits["figures"], limits["figureBase64"])
        if left:
            result["figuresLeftOut"] = left
    except Exception as error:
        result["figures"] = []
        result["error"] = result.get("error", "") + "Drawing the figures failed:\n" + trace(error)
    result["files"] = written(root, before, limits["fileText"])
    return json.dumps(result)
`

type Driver = (
  code: string,
  files: unknown,
  session: string | null,
  limits: unknown,
) => Promise<string>

/** A Pyodide ready to run requests: the interpreter and its driver. */
export interface PreparedPython {
  py: PyodideAPI
  run: Driver
}

/**
 * Readies a loaded Pyodide: its output goes to `emit` as it is written, the
 * packages every run uses are loaded, and the driver is defined.
 */
export async function preparePython(
  py: PyodideAPI,
  emit: (stream: PythonStream, text: string) => void,
): Promise<PreparedPython> {
  for (const stream of ['stdout', 'stderr'] as const) {
    const decoder = new TextDecoder()
    const write = (bytes: Uint8Array) => {
      emit(stream, decoder.decode(bytes, { stream: true }))
      return bytes.length
    }
    if (stream === 'stdout') py.setStdout({ write })
    else py.setStderr({ write })
  }
  await py.loadPackage(['micropip', 'pyodide-http'], {
    messageCallback: () => {},
  })
  const namespace = py.toPy({})
  py.runPython(DRIVER, { globals: namespace })
  return { py, run: namespace.get('run') as Driver }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** Runs one request: loads what it imports and asks for, then runs it. */
export async function runPython(
  { py, run }: PreparedPython,
  request: PythonRequest,
  emit: (stream: PythonStream, text: string) => void,
): Promise<PythonRunResult> {
  const before = new Set(Object.keys(py.loadedPackages))
  const loadedSince = () =>
    Object.keys(py.loadedPackages).filter((name) => !before.has(name))
  await py.loadPackagesFromImports(request.code, {
    messageCallback: () => {},
    errorCallback: (text) => emit('stderr', `${text}\n`),
  })
  if (request.packages?.length) {
    const micropip = py.pyimport('micropip')
    try {
      const packages = py.toPy(request.packages)
      try {
        await micropip.install(packages)
      } finally {
        packages.destroy()
      }
    } catch (error) {
      return {
        error: `Installing ${request.packages.join(', ')} with micropip failed:\n${message(error)}`,
        figures: [],
        files: [],
        loaded: loadedSince(),
      }
    } finally {
      micropip.destroy()
    }
  }
  const files = py.toPy(request.files ?? {})
  const limits = py.toPy(RUN_LIMITS)
  let text: string
  try {
    text = await run(request.code, files, request.session ?? null, limits)
  } finally {
    files.destroy()
    limits.destroy()
  }
  return { ...(JSON.parse(text) as PythonRunResult), loaded: loadedSince() }
}
