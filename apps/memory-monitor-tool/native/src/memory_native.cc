// memory_native.cc - Windows native memory info addon for Electron Memory Monitor Tool
//
// Uses Win32 API to get process memory details directly (Private Working Set).
// Exports:
//   - getProcessMemoryDetails(pid)
//   - getPrivateWorkingSet(pid)
//   - batchGetPrivateWorkingSet(pids[])
//   - batchGetProcessMemory(pids[])
//   - enumerateProcessTree(rootPid) — Toolhelp32 + QueryFullProcessImageName + NtQueryInformationProcess
//   - gatherExternalMonitorSnapshotAsync(rootPid) — Promise；同上枚举 + 每 PID 内存与 Times/IO，在 AsyncWorker 中执行
//   - batchGetProcessTimesAndIo(pids[]) — GetProcessTimes + GetProcessIoCounters（主进程算间隔速率）
//   - queryGpuSystemSnapshotAsync([pids]) — Promise；PDH 采样 GPU；可选 PID 数组按实例名 pid_* 过滤（对齐任务管理器进程列）
//
// Built with N-API (node-addon-api) for ABI stability.
// Windows 系统头必须在 napi.h 之前，否则 NTAPI 等宏可能与 node-addon-api 冲突。

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <winternl.h>
#include <cwchar>
#include <queue>
#include <set>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#define PDH_LONG_VERSION
#include <pdh.h>
#include <pdhmsg.h>
#include <cmath>
#pragma comment(lib, "psapi.lib")
#pragma comment(lib, "pdh.lib")

#ifndef NT_SUCCESS
#define NT_SUCCESS(Status) (((NTSTATUS)(Status)) >= 0)
#endif
#endif  // _WIN32 includes only

#include <napi.h>

#ifdef _WIN32

static int64_t GetPrivateWorkingSetBytes(DWORD pid) {
  HANDLE hProcess = OpenProcess(
    PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
    FALSE,
    pid
  );
  if (!hProcess) return -1;

  int64_t privateWsBytes = 0;
  MEMORY_BASIC_INFORMATION mbi;
  LPBYTE addr = 0;
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  DWORD pageSize = si.dwPageSize;

  const size_t BATCH_SIZE = 4096;
  PSAPI_WORKING_SET_EX_INFORMATION* wsInfo =
    (PSAPI_WORKING_SET_EX_INFORMATION*)malloc(sizeof(PSAPI_WORKING_SET_EX_INFORMATION) * BATCH_SIZE);

  if (!wsInfo) { CloseHandle(hProcess); return -1; }

  while (addr < (LPBYTE)si.lpMaximumApplicationAddress) {
    SIZE_T result = VirtualQueryEx(hProcess, addr, &mbi, sizeof(mbi));
    if (result == 0) { addr += pageSize; continue; }

    if (mbi.State == MEM_COMMIT) {
      SIZE_T regionSize = mbi.RegionSize;
      LPBYTE regionBase = (LPBYTE)mbi.BaseAddress;
      SIZE_T numPages = regionSize / pageSize;

      for (SIZE_T offset = 0; offset < numPages; offset += BATCH_SIZE) {
        SIZE_T batchCount = min(BATCH_SIZE, numPages - offset);
        for (SIZE_T i = 0; i < batchCount; i++) {
          wsInfo[i].VirtualAddress = regionBase + (offset + i) * pageSize;
        }
        if (QueryWorkingSetEx(hProcess, wsInfo,
              (DWORD)(batchCount * sizeof(PSAPI_WORKING_SET_EX_INFORMATION)))) {
          for (SIZE_T i = 0; i < batchCount; i++) {
            if (wsInfo[i].VirtualAttributes.Valid && !wsInfo[i].VirtualAttributes.Shared) {
              privateWsBytes += pageSize;
            }
          }
        }
      }
    }
    addr = (LPBYTE)mbi.BaseAddress + mbi.RegionSize;
  }

  free(wsInfo);
  CloseHandle(hProcess);
  return privateWsBytes;
}

static bool GetProcessMemoryDetails(DWORD pid,
    SIZE_T& outWorkingSetSize,
    SIZE_T& outPeakWorkingSetSize,
    SIZE_T& outPrivateUsage,
    SIZE_T& outPagefileUsage) {
  HANDLE hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  if (!hProcess) return false;

  PROCESS_MEMORY_COUNTERS_EX pmc;
  pmc.cb = sizeof(pmc);
  BOOL ok = GetProcessMemoryInfo(hProcess, (PROCESS_MEMORY_COUNTERS*)&pmc, sizeof(pmc));
  CloseHandle(hProcess);
  if (!ok) return false;

  outWorkingSetSize = pmc.WorkingSetSize;
  outPeakWorkingSetSize = pmc.PeakWorkingSetSize;
  outPrivateUsage = pmc.PrivateUsage;
  outPagefileUsage = pmc.PagefileUsage;
  return true;
}

static std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  if (n <= 0) return std::string();
  std::string out(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), &out[0], n, nullptr, nullptr);
  return out;
}

static std::wstring QueryFullImagePath(HANDLE hProcess) {
  wchar_t buf[4096];
  DWORD sz = static_cast<DWORD>(sizeof(buf) / sizeof(buf[0]));
  if (!QueryFullProcessImageNameW(hProcess, 0, buf, &sz)) return std::wstring();
  return std::wstring(buf, sz);
}

#ifndef STATUS_SUCCESS
#define STATUS_SUCCESS ((NTSTATUS)0x00000000L)
#endif

/** Win8+：ProcessCommandLineInformation = 60，避免 Win32 宏与 QueryProcessCommandLine 命名冲突。 */
#ifndef MY_PROCESS_COMMANDLINE_INFORMATION_CLASS
#define MY_PROCESS_COMMANDLINE_INFORMATION_CLASS (60UL)
#endif

typedef struct _MY_PROCESS_COMMANDLINE_INFORMATION {
  UNICODE_STRING CommandLine;
} MY_PROCESS_COMMANDLINE_INFORMATION;

/** 读取进程完整命令行（供 Chromium --type= 等解析）；失败返回空串。 */
static std::wstring QueryProcessCommandLineWide(HANDLE hProcess) {
  typedef NTSTATUS(NTAPI* NtQueryInformationProcessFn)(
      HANDLE ProcessHandle,
      ULONG ProcessInformationClass,
      PVOID ProcessInformation,
      ULONG ProcessInformationLength,
      PULONG ReturnLength);
  static NtQueryInformationProcessFn pNtQIP = nullptr;
  if (!pNtQIP) {
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) return std::wstring();
    pNtQIP = reinterpret_cast<NtQueryInformationProcessFn>(GetProcAddress(ntdll, "NtQueryInformationProcess"));
    if (!pNtQIP) return std::wstring();
  }

  constexpr ULONG kExtra = 65536;
  std::vector<BYTE> buf(sizeof(MY_PROCESS_COMMANDLINE_INFORMATION) + kExtra);
  ULONG retLen = 0;
  NTSTATUS st = pNtQIP(
      hProcess,
      MY_PROCESS_COMMANDLINE_INFORMATION_CLASS,
      buf.data(),
      static_cast<ULONG>(buf.size()),
      &retLen);
  if (st != STATUS_SUCCESS || retLen < sizeof(UNICODE_STRING)) return std::wstring();

  auto* pci = reinterpret_cast<MY_PROCESS_COMMANDLINE_INFORMATION*>(buf.data());
  USHORT nbytes = pci->CommandLine.Length;
  if (nbytes == 0 || pci->CommandLine.Buffer == nullptr) return std::wstring();

  const BYTE* base = buf.data();
  const BYTE* end = base + buf.size();
  const BYTE* str = reinterpret_cast<const BYTE*>(pci->CommandLine.Buffer);
  if (str < base || str + nbytes > end) return std::wstring();
  return std::wstring(reinterpret_cast<const wchar_t*>(str), nbytes / sizeof(wchar_t));
}

Napi::Value GetProcessMemoryDetailsNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected pid (number)").ThrowAsJavaScriptException();
    return env.Null();
  }

  DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  SIZE_T ws, peakWs, privateUsage, pagefileUsage;
  if (!GetProcessMemoryDetails(pid, ws, peakWs, privateUsage, pagefileUsage)) return env.Null();

  auto result = Napi::Object::New(env);
  result.Set("workingSetSize", Napi::Number::New(env, (double)ws));
  result.Set("peakWorkingSetSize", Napi::Number::New(env, (double)peakWs));
  result.Set("privateUsage", Napi::Number::New(env, (double)privateUsage));
  result.Set("pagefileUsage", Napi::Number::New(env, (double)pagefileUsage));
  return result;
#else
  return env.Null();
#endif
}

Napi::Value GetPrivateWorkingSetNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected pid (number)").ThrowAsJavaScriptException();
    return env.Null();
  }
  DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  int64_t bytes = GetPrivateWorkingSetBytes(pid);
  return Napi::Number::New(env, (double)bytes);
#else
  return Napi::Number::New(env, -1.0);
#endif
}

Napi::Value BatchGetPrivateWorkingSetNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto result = Napi::Object::New(env);

#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "Expected pids (number[])").ThrowAsJavaScriptException();
    return result;
  }

  Napi::Array pids = info[0].As<Napi::Array>();
  uint32_t len = pids.Length();

  for (uint32_t i = 0; i < len; i++) {
    Napi::Value val = pids[i];
    if (!val.IsNumber()) continue;
    DWORD pid = val.As<Napi::Number>().Uint32Value();
    int64_t bytes = GetPrivateWorkingSetBytes(pid);
    if (bytes >= 0) result.Set(std::to_string(pid), Napi::Number::New(env, (double)bytes));
  }
#endif

  return result;
}

Napi::Value BatchGetProcessMemoryNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto result = Napi::Object::New(env);

#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "Expected pids (number[])").ThrowAsJavaScriptException();
    return result;
  }

  Napi::Array pids = info[0].As<Napi::Array>();
  uint32_t len = pids.Length();

  for (uint32_t i = 0; i < len; i++) {
    Napi::Value val = pids[i];
    if (!val.IsNumber()) continue;
    DWORD pid = val.As<Napi::Number>().Uint32Value();
    SIZE_T ws, peakWs, privateUsage, pagefileUsage;
    if (GetProcessMemoryDetails(pid, ws, peakWs, privateUsage, pagefileUsage)) {
      auto obj = Napi::Object::New(env);
      obj.Set("workingSetSize", Napi::Number::New(env, (double)ws));
      obj.Set("peakWorkingSetSize", Napi::Number::New(env, (double)peakWs));
      obj.Set("privateUsage", Napi::Number::New(env, (double)privateUsage));
      obj.Set("pagefileUsage", Napi::Number::New(env, (double)pagefileUsage));
      result.Set(std::to_string(pid), obj);
    }
  }
#endif

  return result;
}

static double FiletimeToDouble100ns(const FILETIME& ft) {
  ULARGE_INTEGER u;
  u.LowPart = ft.dwLowDateTime;
  u.HighPart = ft.dwHighDateTime;
  return static_cast<double>(u.QuadPart);
}

Napi::Value BatchGetProcessTimesAndIoNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "Expected pids (number[])").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Array pids = info[0].As<Napi::Array>();
  Napi::Object result = Napi::Object::New(env);
  uint32_t len = pids.Length();
  for (uint32_t i = 0; i < len; i++) {
    Napi::Value val = pids[i];
    if (!val.IsNumber()) continue;
    DWORD pid = val.As<Napi::Number>().Uint32Value();
    if (pid == 0) continue;
    void* ph;
    ph = ::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (ph == nullptr) continue;
    FILETIME tc, te, tk, tu;
    IO_COUNTERS io;
    BOOL okTimes = GetProcessTimes(static_cast<HANDLE>(ph), &tc, &te, &tk, &tu);
    BOOL okIo = GetProcessIoCounters(static_cast<HANDLE>(ph), &io);
    CloseHandle(static_cast<HANDLE>(ph));
    if (!okTimes) continue;
    Napi::Object o = Napi::Object::New(env);
    o.Set("userTime100ns", Napi::Number::New(env, FiletimeToDouble100ns(tu)));
    o.Set("kernelTime100ns", Napi::Number::New(env, FiletimeToDouble100ns(tk)));
    if (okIo) {
      o.Set("readBytes", Napi::Number::New(env, static_cast<double>(io.ReadTransferCount)));
      o.Set("writeBytes", Napi::Number::New(env, static_cast<double>(io.WriteTransferCount)));
    } else {
      o.Set("readBytes", Napi::Number::New(env, 0.0));
      o.Set("writeBytes", Napi::Number::New(env, 0.0));
    }
    result.Set(std::to_string(pid), o);
  }
  return result;
#else
  return Napi::Object::New(env);
#endif
}

/** 单进程在子树快照中的一行（宽字符串在转 JS 时再 UTF-8）。 */
struct ProcSnapRow {
  DWORD pid;
  DWORD parentPid;
  std::wstring displayName;
  std::wstring exePath;
  std::wstring cmdLine;
};

/** Toolhelp32 BFS + 每 PID OpenProcess 读镜像与命令行；供同步 enumerate 与 AsyncWorker 共用。 */
static bool GatherSubtreeProcRows(DWORD rootPid, std::vector<ProcSnapRow>* out_rows) {
  out_rows->clear();
  if (rootPid == 0) return false;

  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return false;

  std::unordered_map<DWORD, std::vector<DWORD>> children;
  std::unordered_map<DWORD, DWORD> parentOf;
  std::unordered_map<DWORD, std::wstring> shortExe;
  PROCESSENTRY32W pe;
  pe.dwSize = sizeof(pe);
  if (Process32FirstW(snap, &pe)) {
    do {
      DWORD pid = pe.th32ProcessID;
      DWORD ppid = pe.th32ParentProcessID;
      parentOf[pid] = ppid;
      children[ppid].push_back(pid);
      shortExe[pid] = pe.szExeFile;
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);

  std::vector<DWORD> order;
  std::set<DWORD> visited;
  std::queue<DWORD> q;
  q.push(rootPid);
  while (!q.empty()) {
    DWORD cur = q.front();
    q.pop();
    if (!visited.insert(cur).second) continue;
    order.push_back(cur);
    auto it = children.find(cur);
    if (it != children.end()) {
      for (DWORD c : it->second) {
        if (visited.find(c) == visited.end()) q.push(c);
      }
    }
  }

  for (DWORD pid : order) {
    ProcSnapRow row;
    row.pid = pid;
    auto pit = parentOf.find(pid);
    row.parentPid = (pit != parentOf.end()) ? pit->second : 0;

    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    row.exePath.clear();
    row.cmdLine.clear();
    if (h) {
      row.exePath = QueryFullImagePath(h);
      row.cmdLine = QueryProcessCommandLineWide(h);
      CloseHandle(h);
    }
    std::wstring shortName = shortExe.count(pid) ? shortExe[pid] : std::wstring();
    row.displayName = shortName;
    if (!row.exePath.empty()) {
      size_t pos = row.exePath.find_last_of(L"\\/");
      if (pos != std::wstring::npos) row.displayName = row.exePath.substr(pos + 1);
      else row.displayName = row.exePath;
    }
    out_rows->push_back(std::move(row));
  }
  return !out_rows->empty();
}

/** 与 TS filterProcessTreeRowsStrictDescendants 一致：仅保留父链能回到 root 的节点。 */
static void FilterProcessTreeRowsStrictDescendantsCpp(DWORD rootPid, std::vector<ProcSnapRow>* io_rows) {
  if (io_rows->size() <= 1) return;
  std::unordered_map<DWORD, DWORD> parents;
  for (const auto& r : *io_rows) {
    if (r.parentPid > 0) parents[r.pid] = r.parentPid;
  }
  if (parents.empty()) return;

  auto under = [&](DWORD start) -> bool {
    std::set<DWORD> seen;
    DWORD cur = start;
    for (int i = 0; i < 4096; ++i) {
      if (cur == rootPid) return true;
      if (seen.count(cur)) return false;
      seen.insert(cur);
      auto it = parents.find(cur);
      if (it == parents.end() || it->second <= 0) return false;
      cur = it->second;
    }
    return false;
  };

  std::vector<ProcSnapRow> kept;
  kept.reserve(io_rows->size());
  for (const auto& r : *io_rows) {
    if (r.pid == rootPid || under(r.pid)) kept.push_back(r);
  }
  if (!kept.empty()) *io_rows = std::move(kept);
}

Napi::Value EnumerateProcessTreeNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected rootPid (number)").ThrowAsJavaScriptException();
    return env.Null();
  }
  DWORD rootPid = info[0].As<Napi::Number>().Uint32Value();
  Napi::Array out = Napi::Array::New(env);
  if (rootPid == 0) return out;

  std::vector<ProcSnapRow> rows;
  if (!GatherSubtreeProcRows(rootPid, &rows)) return out;

  uint32_t idx = 0;
  for (const auto& r : rows) {
    Napi::Object row = Napi::Object::New(env);
    row.Set("pid", Napi::Number::New(env, (double)r.pid));
    row.Set("parentPid", Napi::Number::New(env, (double)r.parentPid));
    row.Set("name", Napi::String::New(env, WideToUtf8(r.displayName)));
    row.Set("exePath", Napi::String::New(env, WideToUtf8(r.exePath)));
    row.Set("commandLine", Napi::String::New(env, WideToUtf8(r.cmdLine)));
    out.Set(idx++, row);
  }
  return out;
#else
  return Napi::Array::New(env, 0);
#endif
}

struct GatheredPidMetrics {
  DWORD pid;
  DWORD parentPid;
  std::string name;
  std::string exePath;
  std::string cmdLine;
  double privKb;
  double wsKb;
  double peakKb;
  double userTime100ns;
  double kernelTime100ns;
  double readBytes;
  double writeBytes;
};

class ExternalGatherMonitorWorker : public Napi::AsyncWorker {
 public:
  ExternalGatherMonitorWorker(Napi::Env env, DWORD rootPid)
    : Napi::AsyncWorker(env, "mmtExternalGather"),
      deferred_(Napi::Promise::Deferred::New(env)),
      rootPid_(rootPid) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 protected:
  void Execute() override {
#ifdef _WIN32
    if (rootPid_ == 0) return;
    std::vector<ProcSnapRow> rows;
    if (!GatherSubtreeProcRows(rootPid_, &rows)) return;
    // 父链过滤在 TS 层与 enumerateProcessTreeNativeSync 一致；此处 C++ 过滤曾误伤子进程导致只余根 PID

    for (const auto& r : rows) {
      GatheredPidMetrics g;
      g.pid = r.pid;
      g.parentPid = r.parentPid;
      g.name = WideToUtf8(r.displayName);
      g.exePath = WideToUtf8(r.exePath);
      g.cmdLine = WideToUtf8(r.cmdLine);

      int64_t privBytes = GetPrivateWorkingSetBytes(r.pid);
      SIZE_T ws = 0, peakWs = 0, privU = 0, pf = 0;
      if (!GetProcessMemoryDetails(r.pid, ws, peakWs, privU, pf)) {
        ws = peakWs = privU = 0;
      }
      double privKb = (privBytes >= 0) ? std::floor(static_cast<double>(privBytes) / 1024.0) : 0.0;
      double wsKb = std::floor(static_cast<double>(ws) / 1024.0);
      if (wsKb < 0) wsKb = 0;
      double peakKb = std::floor(static_cast<double>(peakWs) / 1024.0);
      if (peakKb < 0) peakKb = 0;
      if (privKb <= 0) privKb = wsKb;
      if (peakKb <= 0) peakKb = wsKb;
      g.privKb = privKb;
      g.wsKb = wsKb;
      g.peakKb = peakKb;

      g.userTime100ns = 0;
      g.kernelTime100ns = 0;
      g.readBytes = 0;
      g.writeBytes = 0;
      HANDLE ph = ::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, r.pid);
      if (ph) {
        FILETIME tc, te, tk, tu;
        IO_COUNTERS io;
        BOOL okTimes = GetProcessTimes(static_cast<HANDLE>(ph), &tc, &te, &tk, &tu);
        BOOL okIo = GetProcessIoCounters(static_cast<HANDLE>(ph), &io);
        CloseHandle(ph);
        if (okTimes) {
          g.userTime100ns = FiletimeToDouble100ns(tu);
          g.kernelTime100ns = FiletimeToDouble100ns(tk);
        }
        if (okIo) {
          g.readBytes = static_cast<double>(io.ReadTransferCount);
          g.writeBytes = static_cast<double>(io.WriteTransferCount);
        }
      }
      gathered_.push_back(std::move(g));
    }
#endif
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope hs(env);
#ifdef _WIN32
    if (gathered_.empty()) {
      deferred_.Resolve(env.Null());
      return;
    }
    Napi::Object root = Napi::Object::New(env);
    Napi::Array tree = Napi::Array::New(env);
    Napi::Object memory = Napi::Object::New(env);
    Napi::Object timesIo = Napi::Object::New(env);
    uint32_t ti = 0;
    for (const auto& g : gathered_) {
      Napi::Object row = Napi::Object::New(env);
      row.Set("pid", Napi::Number::New(env, static_cast<double>(g.pid)));
      row.Set("parentPid", Napi::Number::New(env, static_cast<double>(g.parentPid)));
      row.Set("name", Napi::String::New(env, g.name));
      row.Set("exePath", Napi::String::New(env, g.exePath));
      row.Set("commandLine", Napi::String::New(env, g.cmdLine));
      tree.Set(ti++, row);

      Napi::Object m = Napi::Object::New(env);
      m.Set("privateKb", Napi::Number::New(env, g.privKb));
      m.Set("workingSetKb", Napi::Number::New(env, g.wsKb));
      m.Set("peakKb", Napi::Number::New(env, g.peakKb));
      memory.Set(std::to_string(g.pid), m);

      Napi::Object t = Napi::Object::New(env);
      t.Set("userTime100ns", Napi::Number::New(env, g.userTime100ns));
      t.Set("kernelTime100ns", Napi::Number::New(env, g.kernelTime100ns));
      t.Set("readBytes", Napi::Number::New(env, g.readBytes));
      t.Set("writeBytes", Napi::Number::New(env, g.writeBytes));
      timesIo.Set(std::to_string(g.pid), t);
    }
    root.Set("tree", tree);
    root.Set("memory", memory);
    root.Set("timesIo", timesIo);
    deferred_.Resolve(root);
#else
    deferred_.Resolve(env.Null());
#endif
  }

  void OnError(const Napi::Error& err) override { deferred_.Reject(err.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  DWORD rootPid_;
  std::vector<GatheredPidMetrics> gathered_;
};

Napi::Value GatherExternalMonitorSnapshotAsyncNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected rootPid (number)").ThrowAsJavaScriptException();
    return env.Null();
  }
  DWORD root = info[0].As<Napi::Number>().Uint32Value();
  ExternalGatherMonitorWorker* w = new ExternalGatherMonitorWorker(env, root);
  Napi::Promise p = w->GetPromise();
  w->Queue();
  return p;
#else
  Napi::Promise::Deferred def = Napi::Promise::Deferred::New(env);
  def.Resolve(env.Null());
  return def.Promise();
#endif
}

static bool IsPdhValueUsable(DWORD status) {
  return status == PDH_CSTATUS_VALID_DATA || status == PDH_CSTATUS_NEW_DATA;
}

static std::wstring LowerWide(std::wstring s) {
  if (!s.empty()) {
    ::CharLowerBuffW(&s[0], static_cast<DWORD>(s.size()));
  }
  return s;
}

/**
 * 从 PDH 实例名中解析首个 pid_12345 形式的进程号（不区分大小写）。
 * GPU Engine / GPU Process Memory 实例名通常含 pid_<decimal>。
 */
static DWORD TryExtractPidFromPdhInstanceName(const wchar_t* szName) {
  if (!szName) return 0;
  std::wstring s = LowerWide(std::wstring(szName));
  const std::wstring key = L"pid_";
  size_t pos = 0;
  while ((pos = s.find(key, pos)) != std::wstring::npos) {
    pos += key.length();
    uint64_t val = 0;
    size_t i = pos;
    while (i < s.size() && s[i] >= L'0' && s[i] <= L'9') {
      val = val * 10u + static_cast<uint64_t>(s[i] - L'0');
      if (val > 0xFFFFFFFFull) {
        val = 0;
        break;
      }
      ++i;
    }
    if (i > pos && val >= 1ull) {
      return static_cast<DWORD>(val);
    }
    pos = (i > pos ? i : pos + 1);
  }
  return 0;
}

static std::unordered_set<DWORD> MakePidSet(const std::vector<DWORD>& pids) {
  return std::unordered_set<DWORD>(pids.begin(), pids.end());
}

/** 无 PID 过滤：取所有引擎实例的**最大值**，避免大量 0 实例把均值稀释成 0。 */
static bool ReadGpuEngineUtilMax(PDH_HCOUNTER hCounter, double* outVal) {
  DWORD bufSize = 0;
  DWORD itemCount = 0;
  PDH_STATUS st = PdhGetFormattedCounterArrayW(hCounter, PDH_FMT_DOUBLE, &bufSize, &itemCount, NULL);
  if (st != PDH_MORE_DATA || bufSize == 0) return false;
  std::vector<BYTE> buffer(bufSize);
  auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buffer.data());
  st = PdhGetFormattedCounterArrayW(hCounter, PDH_FMT_DOUBLE, &bufSize, &itemCount, items);
  if (st != ERROR_SUCCESS || itemCount == 0) return false;
  double mx = -1;
  DWORD n = 0;
  for (DWORD i = 0; i < itemCount; ++i) {
    if (!IsPdhValueUsable(items[i].FmtValue.CStatus)) continue;
    double v = items[i].FmtValue.doubleValue;
    if (!std::isnan(v) && v >= 0) {
      mx = (n == 0) ? v : (v > mx ? v : mx);
      ++n;
    }
  }
  if (n == 0) return false;
  *outVal = mx;
  return true;
}

/**
 * 子树 PID：按实例名解析出进程号；同一 PID 多实例取**最大**引擎%，再对子树内各 PID 求和（上限 100）。
 * 避免同一进程多实例把 Dedicated/Util 重复相加接近整卡。
 */
static bool ReadGpuEngineUtilAggregatedForPids(PDH_HCOUNTER hCounter, const std::vector<DWORD>& pids, double* outVal) {
  const std::unordered_set<DWORD> want = MakePidSet(pids);
  DWORD bufSize = 0;
  DWORD itemCount = 0;
  PDH_STATUS st = PdhGetFormattedCounterArrayW(hCounter, PDH_FMT_DOUBLE, &bufSize, &itemCount, NULL);
  if (st != PDH_MORE_DATA || bufSize == 0) return false;
  std::vector<BYTE> buffer(bufSize);
  auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buffer.data());
  st = PdhGetFormattedCounterArrayW(hCounter, PDH_FMT_DOUBLE, &bufSize, &itemCount, items);
  if (st != ERROR_SUCCESS || itemCount == 0) return false;
  std::unordered_map<DWORD, double> utilMaxPerPid;
  for (DWORD i = 0; i < itemCount; ++i) {
    if (!IsPdhValueUsable(items[i].FmtValue.CStatus)) continue;
    DWORD apid = TryExtractPidFromPdhInstanceName(items[i].szName);
    if (apid == 0 || want.count(apid) == 0) continue;
    double v = items[i].FmtValue.doubleValue;
    if (std::isnan(v) || v < 0) continue;
    auto it = utilMaxPerPid.find(apid);
    if (it == utilMaxPerPid.end() || v > it->second) utilMaxPerPid[apid] = v;
  }
  if (utilMaxPerPid.empty()) return false;
  double sum = 0;
  for (const auto& kv : utilMaxPerPid) sum += kv.second;
  if (sum > 100.0) sum = 100.0;
  *outVal = sum;
  return true;
}

/** 整卡专用显存：多适配器实例取**最大**单列值，避免误加重复实例。 */
static bool ReadGpuDedicatedBytesMax(PDH_HCOUNTER hCounter, double* outMaxBytes) {
  DWORD bufSize = 0;
  DWORD itemCount = 0;
  PDH_STATUS st = PdhGetFormattedCounterArrayW(hCounter, PDH_FMT_LARGE, &bufSize, &itemCount, NULL);
  if (st != PDH_MORE_DATA || bufSize == 0) return false;
  std::vector<BYTE> buffer(bufSize);
  auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buffer.data());
  st = PdhGetFormattedCounterArrayW(hCounter, PDH_FMT_LARGE, &bufSize, &itemCount, items);
  if (st != ERROR_SUCCESS || itemCount == 0) return false;
  double mx = -1;
  DWORD n = 0;
  for (DWORD i = 0; i < itemCount; ++i) {
    if (!IsPdhValueUsable(items[i].FmtValue.CStatus)) continue;
    LONGLONG lv = items[i].FmtValue.largeValue;
    if (lv < 0) continue;
    double v = static_cast<double>(lv);
    mx = (n == 0) ? v : (v > mx ? v : mx);
    ++n;
  }
  if (n == 0) return false;
  *outMaxBytes = mx;
  return true;
}

/**
 * 子树：GPU Process Memory Dedicated 字节；按 PID 去重（同 PID 多实例取最大），再对子树内各 PID 相加。
 * 对齐任务管理器「专用 GPU 内存」在进程组上的汇总，避免误加成整卡占用。
 */
static bool ReadGpuProcessDedicatedBytesAggregatedForPids(PDH_HCOUNTER hCounter, const std::vector<DWORD>& pids, double* outSumBytes) {
  const std::unordered_set<DWORD> want = MakePidSet(pids);
  DWORD bufSize = 0;
  DWORD itemCount = 0;
  PDH_STATUS st = PdhGetFormattedCounterArrayW(hCounter, PDH_FMT_LARGE, &bufSize, &itemCount, NULL);
  if (st != PDH_MORE_DATA || bufSize == 0) return false;
  std::vector<BYTE> buffer(bufSize);
  auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buffer.data());
  st = PdhGetFormattedCounterArrayW(hCounter, PDH_FMT_LARGE, &bufSize, &itemCount, items);
  if (st != ERROR_SUCCESS || itemCount == 0) return false;
  std::unordered_map<DWORD, double> bytesMaxPerPid;
  for (DWORD i = 0; i < itemCount; ++i) {
    if (!IsPdhValueUsable(items[i].FmtValue.CStatus)) continue;
    DWORD apid = TryExtractPidFromPdhInstanceName(items[i].szName);
    if (apid == 0 || want.count(apid) == 0) continue;
    LONGLONG lv = items[i].FmtValue.largeValue;
    if (lv < 0) continue;
    double v = static_cast<double>(lv);
    auto it = bytesMaxPerPid.find(apid);
    if (it == bytesMaxPerPid.end() || v > it->second) bytesMaxPerPid[apid] = v;
  }
  if (bytesMaxPerPid.empty()) return false;
  double sum = 0;
  for (const auto& kv : bytesMaxPerPid) sum += kv.second;
  *outSumBytes = sum;
  return true;
}

/**
 * 两次 Collect 间隔 1s 再读数。
 * - filterPids 为空：整机视角 —— 引擎% 取实例最大值；显存取适配器 Dedicated 峰值。
 * - filterPids 非空：外部子树 —— 引擎% 对实例名含 pid_* 的项求和（上限 100）；显存用 GPU Process Memory 匹配 PID 求和。
 */
static void SampleGpuSystemPdh(
    const std::vector<DWORD>& filterPids,
    bool* outUtilOk,
    bool* outMemOk,
    double* outUtil,
    double* outMemBytes) {
  *outUtilOk = false;
  *outMemOk = false;
  *outUtil = NAN;
  *outMemBytes = NAN;

  PDH_HQUERY query = NULL;
  PDH_HCOUNTER ctrUtil = NULL;
  PDH_HCOUNTER ctrAdapterMem = NULL;
  PDH_HCOUNTER ctrProcMem = NULL;

  PDH_STATUS st = PdhOpenQueryA(NULL, 0, &query);
  if (st != ERROR_SUCCESS) return;

  st = PdhAddEnglishCounterA(query, "\\GPU Engine(*)\\Utilization Percentage", 0, &ctrUtil);
  if (st != ERROR_SUCCESS) {
    PdhCloseQuery(query);
    return;
  }

  const bool subtree = !filterPids.empty();
  if (subtree) {
    st = PdhAddEnglishCounterA(query, "\\GPU Process Memory(*)\\Dedicated Usage", 0, &ctrProcMem);
    if (st != ERROR_SUCCESS) ctrProcMem = NULL;
  } else {
    st = PdhAddEnglishCounterA(query, "\\GPU Adapter Memory(*)\\Dedicated Usage", 0, &ctrAdapterMem);
    if (st != ERROR_SUCCESS) ctrAdapterMem = NULL;
  }

  st = PdhCollectQueryData(query);
  if (st != ERROR_SUCCESS) {
    PdhRemoveCounter(ctrUtil);
    if (ctrAdapterMem) PdhRemoveCounter(ctrAdapterMem);
    if (ctrProcMem) PdhRemoveCounter(ctrProcMem);
    PdhCloseQuery(query);
    return;
  }

  Sleep(1000);

  st = PdhCollectQueryData(query);
  if (st != ERROR_SUCCESS) {
    PdhRemoveCounter(ctrUtil);
    if (ctrAdapterMem) PdhRemoveCounter(ctrAdapterMem);
    if (ctrProcMem) PdhRemoveCounter(ctrProcMem);
    PdhCloseQuery(query);
    return;
  }

  double u = NAN;
  if (subtree) {
    if (ReadGpuEngineUtilAggregatedForPids(ctrUtil, filterPids, &u)) {
      *outUtilOk = true;
      *outUtil = u;
    } else if (ReadGpuEngineUtilMax(ctrUtil, &u)) {
      /* 实例名无法解析 pid 时退化为整机「最忙引擎」峰值，避免一直 0 */
      *outUtilOk = true;
      *outUtil = u;
    }
  } else {
    if (ReadGpuEngineUtilMax(ctrUtil, &u)) {
      *outUtilOk = true;
      *outUtil = u;
    }
  }

  if (subtree && ctrProcMem) {
    double m = NAN;
    if (ReadGpuProcessDedicatedBytesAggregatedForPids(ctrProcMem, filterPids, &m)) {
      *outMemOk = true;
      *outMemBytes = m;
    }
    PdhRemoveCounter(ctrProcMem);
  } else if (!subtree && ctrAdapterMem) {
    double m = NAN;
    if (ReadGpuDedicatedBytesMax(ctrAdapterMem, &m)) {
      *outMemOk = true;
      *outMemBytes = m;
    }
    PdhRemoveCounter(ctrAdapterMem);
  }

  PdhRemoveCounter(ctrUtil);
  PdhCloseQuery(query);
}

class GpuPdhWorker : public Napi::AsyncWorker {
 public:
  GpuPdhWorker(Napi::Env env, std::vector<DWORD> filterPids)
    : Napi::AsyncWorker(env, "mmtGpuPdh"),
      deferred_(Napi::Promise::Deferred::New(env)),
      filterPids_(std::move(filterPids)),
      utilOk_(false),
      memOk_(false),
      util_(0),
      memBytes_(0) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 protected:
  void Execute() override {
    SampleGpuSystemPdh(filterPids_, &utilOk_, &memOk_, &util_, &memBytes_);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope hs(env);
    Napi::Object o = Napi::Object::New(env);
    if (utilOk_ && !std::isnan(util_) && util_ >= 0) {
      double rounded = std::round(util_ * 10.0) / 10.0;
      o.Set("engineUtilPercent", Napi::Number::New(env, rounded));
    } else {
      o.Set("engineUtilPercent", env.Null());
    }
    if (memOk_ && !std::isnan(memBytes_) && memBytes_ >= 0) {
      double mb = std::round((memBytes_ / (1024.0 * 1024.0)) * 10.0) / 10.0;
      o.Set("dedicatedUsedMB", Napi::Number::New(env, mb));
    } else {
      o.Set("dedicatedUsedMB", env.Null());
    }
    deferred_.Resolve(o);
  }

  void OnError(const Napi::Error& err) override { deferred_.Reject(err.Value()); }

 private:
  Napi::Promise::Deferred deferred_;
  std::vector<DWORD> filterPids_;
  bool utilOk_;
  bool memOk_;
  double util_;
  double memBytes_;
};

Napi::Value QueryGpuSystemSnapshotAsyncNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#ifdef _WIN32
  std::vector<DWORD> filterPids;
  if (info.Length() >= 1 && info[0].IsArray()) {
    Napi::Array arr = info[0].As<Napi::Array>();
    uint32_t len = arr.Length();
    for (uint32_t i = 0; i < len; ++i) {
      Napi::Value v = arr.Get(i);
      if (!v.IsNumber()) continue;
      double d = v.As<Napi::Number>().DoubleValue();
      if (d >= 1.0 && d <= 2147483647.0) {
        filterPids.push_back(static_cast<DWORD>(d));
      }
    }
  }
  GpuPdhWorker* w = new GpuPdhWorker(env, std::move(filterPids));
  Napi::Promise p = w->GetPromise();
  w->Queue();
  return p;
#else
  Napi::Promise::Deferred def = Napi::Promise::Deferred::New(env);
  Napi::Object o = Napi::Object::New(env);
  o.Set("engineUtilPercent", env.Null());
  o.Set("dedicatedUsedMB", env.Null());
  def.Resolve(o);
  return def.Promise();
#endif
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getProcessMemoryDetails", Napi::Function::New(env, GetProcessMemoryDetailsNapi));
  exports.Set("getPrivateWorkingSet", Napi::Function::New(env, GetPrivateWorkingSetNapi));
  exports.Set("batchGetPrivateWorkingSet", Napi::Function::New(env, BatchGetPrivateWorkingSetNapi));
  exports.Set("batchGetProcessMemory", Napi::Function::New(env, BatchGetProcessMemoryNapi));
  exports.Set("enumerateProcessTree", Napi::Function::New(env, EnumerateProcessTreeNapi));
  exports.Set("gatherExternalMonitorSnapshotAsync", Napi::Function::New(env, GatherExternalMonitorSnapshotAsyncNapi));
  exports.Set("batchGetProcessTimesAndIo", Napi::Function::New(env, BatchGetProcessTimesAndIoNapi));
  exports.Set("queryGpuSystemSnapshotAsync", Napi::Function::New(env, QueryGpuSystemSnapshotAsyncNapi));
  return exports;
}

NODE_API_MODULE(memory_native, Init)

#endif  // _WIN32
