from pathlib import Path
import json,hashlib,xml.etree.ElementTree as ET
root=Path(__file__).resolve().parents[1]
expected=json.loads((root/'QA/source-sha256.json').read_text())
collection=json.loads((root/'Resources/collection.json').read_text())
assert len(collection['pieces']) == len(expected) == 15
systems=0;events=0
for piece in collection['pieces']:
    slug=piece['slug'];folder=root/'ReferenceMusic'/slug
    manifest=json.loads((folder/'manifest.json').read_text())
    assert len(manifest['systems'])==piece['systems']
    for s in manifest['systems']:
        assert (folder/s['scan']).exists(),(slug,s['scan'])
    for relative,sha in expected[slug].items():
        xml=folder/relative
        assert xml.exists(),xml
        assert hashlib.sha256(xml.read_bytes()).hexdigest() == sha,relative
        if relative.startswith('excerpts/'):
            events+=len(ET.parse(xml).findall('.//note'))
    systems+=len(manifest['systems'])
assert systems==304,systems
print(json.dumps({'pieces':15,'systems':304,'note_elements':events,'source_integrity':'sha256 matches uploaded handoff'},indent=2))
