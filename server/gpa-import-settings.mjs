// Persist only layout metadata. No source cell values belong in these settings.
export function validateGpaImportMapping(mapping) {
  const fail = () => { throw Object.assign(Error("Choose valid sheet rows and distinct columns for each field."), { status: 422 }); };
  if (!mapping || Array.isArray(mapping) ||
    Object.keys(mapping).sort().join(",") !== "columns,firstDataRow,headerRow,nameMode" ||
    !Number.isInteger(mapping.headerRow) || mapping.headerRow < 0 || mapping.headerRow > 1000 ||
    !Number.isInteger(mapping.firstDataRow) || mapping.firstDataRow < 1 || mapping.firstDataRow > 1100 ||
    (mapping.headerRow && mapping.firstDataRow <= mapping.headerRow) ||
    !["split", "full"].includes(mapping.nameMode) || !mapping.columns ||
    Array.isArray(mapping.columns) ||
    Object.keys(mapping.columns).sort().join(",") !== "email,first,full,gpa,last,schoolId") fail();
  const columns = mapping.columns;
  if (Object.values(columns).some((value) => !Number.isInteger(value) || value < -1 || value > 127)) fail();
  const keys = mapping.nameMode === "full" ? ["full", "gpa"] : ["first", "last", "gpa"];
  keys.push(...["schoolId", "email"].filter((key) => columns[key] >= 0));
  if (keys.some((key) => columns[key] < 0) || new Set(keys.map((key) => columns[key])).size !== keys.length) fail();
  return { headerRow: mapping.headerRow, firstDataRow: mapping.firstDataRow,
    nameMode: mapping.nameMode, columns: { ...columns } };
}
