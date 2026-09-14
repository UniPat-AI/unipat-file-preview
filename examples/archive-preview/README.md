# Archive preview browser smoke test

From the repository root: `pnpm install`, then `pnpm --filter @unipat/file-preview-example-archive dev`.
Open http://127.0.0.1:5188/.

1. The default GZIP TSV renders two data rows, S001/calibration and S002/target.
2. Select review.zip, enter data/, and preview both the GZIP table and result.json.
3. Return to the archive root, preview report.html. It must show “Sandbox preview”, never “UNSAFE SCRIPT EXECUTED”.
4. No download, new-window or print actions should be exposed.

Fixtures contain synthetic data only. The GZIP fixture is served with a .bin suffix because Vite otherwise adds Content-Encoding:gzip; FilePreview receives the original .tsv.gz fileName separately.
