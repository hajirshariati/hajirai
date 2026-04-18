import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || typeof file === "string") {
    return Response.json({ error: "No file provided" }, { status: 400 });
  }

  const stagedRes = await admin.graphql(
    `#graphql
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: [
          {
            resource: "IMAGE",
            filename: file.name,
            mimeType: file.type || "image/png",
            httpMethod: "POST",
            fileSize: String(file.size),
          },
        ],
      },
    },
  );
  const stagedJson = await stagedRes.json();
  const target = stagedJson.data?.stagedUploadsCreate?.stagedTargets?.[0];
  const userErrors = stagedJson.data?.stagedUploadsCreate?.userErrors || [];
  if (!target || userErrors.length) {
    return Response.json(
      { error: userErrors[0]?.message || "Failed to stage upload" },
      { status: 500 },
    );
  }

  const uploadForm = new FormData();
  for (const p of target.parameters) uploadForm.append(p.name, p.value);
  uploadForm.append("file", file);

  const uploadRes = await fetch(target.url, {
    method: "POST",
    body: uploadForm,
  });
  if (!uploadRes.ok) {
    return Response.json(
      { error: `Upload failed (${uploadRes.status})` },
      { status: 500 },
    );
  }

  const fileCreateRes = await admin.graphql(
    `#graphql
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          preview { image { url } }
          ... on MediaImage { image { url } }
        }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        files: [
          {
            alt: file.name,
            contentType: "IMAGE",
            originalSource: target.resourceUrl,
          },
        ],
      },
    },
  );
  const fileJson = await fileCreateRes.json();
  const createErrors = fileJson.data?.fileCreate?.userErrors || [];
  if (createErrors.length) {
    return Response.json({ error: createErrors[0].message }, { status: 500 });
  }
  const fileId = fileJson.data?.fileCreate?.files?.[0]?.id;

  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 600));
    const pollRes = await admin.graphql(
      `#graphql
      query fileStatus($id: ID!) {
        node(id: $id) {
          ... on MediaImage {
            fileStatus
            image { url }
          }
        }
      }`,
      { variables: { id: fileId } },
    );
    const pollJson = await pollRes.json();
    const node = pollJson.data?.node;
    if (node?.image?.url) {
      return Response.json({ url: node.image.url });
    }
    if (node?.fileStatus === "FAILED") {
      return Response.json({ error: "File processing failed" }, { status: 500 });
    }
  }

  return Response.json({ error: "Upload timed out" }, { status: 504 });
};
