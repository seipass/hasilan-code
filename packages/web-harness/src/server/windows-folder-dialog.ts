// Windows PowerShell ships with .NET Framework WinForms, whose FolderBrowserDialog
// can present the legacy tree chooser. Use the shell's Vista-style file dialog instead.
export const windowsFolderDialog = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
internal class FileOpenDialog { }

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("42F85136-DB7E-439C-85F1-E4075D135FC8")]
internal interface IFileDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName(out IntPtr name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, int location);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int error);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
internal interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid result, out IntPtr objectPointer);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint nameFormat, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem item, uint hint, out int order);
}

public static class FolderChooser {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);

    public static string Choose(string initialPath) {
        IFileDialog dialog = (IFileDialog)new FileOpenDialog();
        IShellItem folder = null;
        IShellItem result = null;
        try {
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | 0x20u | 0x40u); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
            dialog.SetTitle("Hasilan Code - ワークスペースを選択");
            Guid iid = typeof(IShellItem).GUID;
            SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref iid, out folder);
            dialog.SetFolder(folder);
            int status = dialog.Show(IntPtr.Zero);
            if (status == unchecked((int)0x800704C7)) return null; // ERROR_CANCELLED
            if (status < 0) Marshal.ThrowExceptionForHR(status);
            dialog.GetResult(out result);
            IntPtr name;
            result.GetDisplayName(0x80058000u, out name); // SIGDN_FILESYSPATH
            try { return Marshal.PtrToStringUni(name); }
            finally { Marshal.FreeCoTaskMem(name); }
        } finally {
            if (result != null) Marshal.ReleaseComObject(result);
            if (folder != null) Marshal.ReleaseComObject(folder);
            Marshal.ReleaseComObject(dialog);
        }
    }
}
'@
$selected = [FolderChooser]::Choose($env:HASILAN_PICKER_CWD)
if ($selected) { [Console]::Write($selected) }`;
