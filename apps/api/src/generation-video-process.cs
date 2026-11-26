// Windows-only launch boundary. No media parsing; the verified FFmpeg tools own that work.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public sealed class VideoProcessResult {
    public int ExitCode; public string StdoutBase64; public string StderrBase64; public string Reason;
}
public static class VideoBoundedProcess {
    [StructLayout(LayoutKind.Sequential)] struct Security { public int Length; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int Size; public string Reserved, Desktop, Title; public int X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
        public short Show, ReservedSize; public IntPtr ReservedPointer, Stdin, Stdout, Stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public int ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit Basic; public Counters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, ref Security security, uint mode, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder args, IntPtr processAttributes, IntPtr threadAttributes,
        bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Close(ref IntPtr handle) { if(handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); handle=IntPtr.Zero; }
    static string Quote(string value) {
        if(value == null || value.IndexOfAny(new char[]{'"','\r','\n','\0'}) >= 0 || value.EndsWith("\\")) throw new Exception("invalid argument");
        return "\""+value+"\"";
    }
    public static VideoProcessResult Run(string executable, string[] arguments, string directory, long memoryBytes, long cpuMs, int wallMs, int stdoutBytes, int stderrBytes) {
        var result = new VideoProcessResult { ExitCode=-1, StdoutBase64="", StderrBase64="", Reason="resource_unavailable" };
        IntPtr job=IntPtr.Zero, outRead=IntPtr.Zero, outWrite=IntPtr.Zero, errRead=IntPtr.Zero, errWrite=IntPtr.Zero, input=IntPtr.Zero, environment=IntPtr.Zero;
        ProcessInfo process = new ProcessInfo(); int exceeded=0;
        try {
            if(memoryBytes<=0 || cpuMs<=0 || wallMs<=0 || stdoutBytes<=0 || stderrBytes<=0) return result;
            // Job Objects are resource boundaries, not filesystem sandboxes. Protect
            // this unique directory before any media is written/read; external MP4
            // data references are separately disabled in the fixed FFmpeg argv.
            var owner=WindowsIdentity.GetCurrent().User;
            var acl=new DirectorySecurity(); acl.SetOwner(owner); acl.SetAccessRuleProtection(true,false);
            acl.AddAccessRule(new FileSystemAccessRule(owner,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
            new DirectoryInfo(directory).SetAccessControl(acl);
            job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) return result;
            var limit=new ExtendedLimit();
            limit.Basic.Flags=0x2|0x8|0x100|0x200|0x2000; // process user-time, active-process, process/job memory, kill-on-close
            limit.Basic.ProcessTime=checked(cpuMs*10000L); limit.Basic.ActiveProcesses=1;
            limit.ProcessMemory=(UIntPtr)(ulong)memoryBytes; limit.JobMemory=(UIntPtr)(ulong)memoryBytes;
            if(!SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(typeof(ExtendedLimit)))) return result;
            var security=new Security { Length=Marshal.SizeOf(typeof(Security)), Inherit=1 };
            if(!CreatePipe(out outRead,out outWrite,ref security,0) || !CreatePipe(out errRead,out errWrite,ref security,0) ||
                !SetHandleInformation(outRead,1,0) || !SetHandleInformation(errRead,1,0)) return result;
            input=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero); if(input==new IntPtr(-1)) return result;
            var startup=new Startup { Size=Marshal.SizeOf(typeof(Startup)), Flags=0x100, Stdin=input, Stdout=outWrite, Stderr=errWrite };
            var command=new StringBuilder(Quote(executable)); foreach(var argument in arguments) command.Append(" ").Append(Quote(argument));
            // Never pass provider/account credentials or the caller's environment to a media tool.
            var environmentText="SystemRoot="+Environment.GetEnvironmentVariable("SystemRoot")+"\0TEMP="+directory+"\0TMP="+directory+"\0\0";
            environment=Marshal.StringToHGlobalUni(environmentText);
            if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x4|0x400|0x8000000,environment,directory,ref startup,out process)) return result;
            if(!AssignProcessToJobObject(job,process.Process)) { TerminateProcess(process.Process,1); return result; }
            Close(ref outWrite); Close(ref errWrite); Close(ref input);
            Func<IntPtr,int,byte[]> collect=(handle,budget)=> {
                using(var file=new FileStream(new SafeFileHandle(handle,true),FileAccess.Read)) using(var bytes=new MemoryStream()) {
                    var buffer=new byte[Math.Min(budget,8192)]; int count;
                    while((count=file.Read(buffer,0,buffer.Length))>0) {
                        if(bytes.Length+count>budget) { Interlocked.Exchange(ref exceeded,1); TerminateJobObject(job,1); break; }
                        bytes.Write(buffer,0,count);
                    }
                    return bytes.ToArray();
                }
            };
            var outHandle=outRead; outRead=IntPtr.Zero; var errHandle=errRead; errRead=IntPtr.Zero;
            var stdout=Task.Run(()=>collect(outHandle,stdoutBytes)); var stderr=Task.Run(()=>collect(errHandle,stderrBytes));
            if(ResumeThread(process.Thread)==UInt32.MaxValue) { TerminateJobObject(job,1); return result; }
            if(WaitForSingleObject(process.Process,(uint)wallMs)!=0) { result.Reason="timeout"; TerminateJobObject(job,1); }
            else result.Reason="exited";
            WaitForSingleObject(process.Process,UInt32.MaxValue);
            uint code; GetExitCodeProcess(process.Process,out code); result.ExitCode=unchecked((int)code);
            result.StdoutBase64=Convert.ToBase64String(stdout.GetAwaiter().GetResult()); result.StderrBase64=Convert.ToBase64String(stderr.GetAwaiter().GetResult());
            if(exceeded!=0) result.Reason="output_limit";
            return result;
        } catch { return result; }
        finally {
            if(job!=IntPtr.Zero) TerminateJobObject(job,1);
            Close(ref process.Thread); Close(ref process.Process); Close(ref job); Close(ref outRead); Close(ref outWrite); Close(ref errRead); Close(ref errWrite); Close(ref input);
            if(environment!=IntPtr.Zero) Marshal.FreeHGlobal(environment);
        }
    }
}
