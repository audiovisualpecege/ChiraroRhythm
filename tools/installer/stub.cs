// Rhythm-<versão>.exe: extrai o pacote embutido (instalador.ps1, Rhythm.zxp, ffmpeg) numa pasta
// temporária e roda o instalador.ps1 repassando os argumentos (/aguardar, /silencioso, /desinstalar).
// Compilado pelo tools\build-exe.ps1 com o csc do .NET Framework que vem no Windows.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("Rhythm")]
[assembly: AssemblyProduct("Rhythm para Premiere Pro")]
[assembly: AssemblyDescription("Instalador do Rhythm")]

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        string dir = Path.Combine(Path.GetTempPath(), "Rhythm-instalador-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        try
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (ZipArchive z = new ZipArchive(s))
                z.ExtractToDirectory(dir);

            string ps = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            string script = Path.Combine(dir, "instalador.ps1");
            string extra = string.Join(" ", args.Select(a => "\"" + a.Replace("\"", "") + "\""));
            ProcessStartInfo psi = new ProcessStartInfo(ps,
                "-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File \"" + script + "\" " + extra);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception e)
        {
            if (!args.Any(a => a.Equals("/silencioso", StringComparison.OrdinalIgnoreCase)))
                MessageBox.Show("Não foi possível abrir o instalador:\n\n" + e.Message, "Rhythm", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch { }
        }
    }
}
