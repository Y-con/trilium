"use strict";

const becca = require('../becca/becca');
const log = require('./log');
const protectedSessionService = require('./protected_session');
const noteService = require('./notes');
const optionService = require('./options');
const sql = require('./sql');
const jimp = require('jimp');
const imageType = require('image-type');
const sanitizeFilename = require('sanitize-filename');
const noteRevisionService = require('./note_revisions');
const isSvg = require('is-svg');
const isAnimated = require('is-animated');

async function processImage(uploadBuffer, originalName, shrinkImageSwitch) {
    const origImageFormat = getImageType(uploadBuffer);

    if (origImageFormat && ["webp", "svg", "gif"].includes(origImageFormat.ext)) {
        // JIMP does not support webp at the moment: https://github.com/oliver-moran/jimp/issues/144
        shrinkImageSwitch = false;
    }
    else if (isAnimated(uploadBuffer)) {
        // recompression of animated images will make them static
        shrinkImageSwitch = false;
    }

    const finalImageBuffer = shrinkImageSwitch ? await shrinkImage(uploadBuffer, originalName) : uploadBuffer;

    const imageFormat = getImageType(finalImageBuffer);

    return {
        buffer: finalImageBuffer,
        imageFormat
    };
}

function getImageType(buffer) {
    if (isSvg(buffer)) {
        return {
            ext: 'svg'
        }
    }
    else {
        return imageType(buffer) || "jpg"; // optimistic JPG default
    }
}

function getImageMimeFromExtension(ext) {
    ext = ext.toLowerCase();

    return 'image/' + (ext === 'svg' ? 'svg+xml' : ext);
}

function updateImage(noteId, uploadBuffer, originalName) {
    log.info(`Updating image ${noteId}: ${originalName}`);

    const note = becca.getNote(noteId);

    noteRevisionService.createNoteRevision(note);
    noteRevisionService.protectNoteRevisions(note);

    note.setLabel('originalFileName', originalName);

    // resizing images asynchronously since JIMP does not support sync operation
    processImage(uploadBuffer, originalName, true).then(({buffer, imageFormat}) => {
        sql.transactional(() => {
            note.mime = getImageMimeFromExtension(imageFormat.ext);
            note.save();

            note.setContent(buffer);
        })
    });
}

function saveImage(parentNoteId, uploadBuffer, originalName, shrinkImageSwitch) {
    log.info(`Saving image ${originalName}`);

    const fileName = sanitizeFilename(originalName);

    const parentNote = becca.getNote(parentNoteId);

    const {note} = noteService.createNewNote({
        parentNoteId,
        title: fileName,
        type: 'image',
        mime: 'unknown',
        content: '',
        isProtected: parentNote.isProtected && protectedSessionService.isProtectedSessionAvailable()
    });

    note.addLabel('originalFileName', originalName);

    // resizing images asynchronously since JIMP does not support sync operation
    processImage(uploadBuffer, originalName, shrinkImageSwitch).then(({buffer, imageFormat}) => {
        sql.transactional(() => {
            note.mime = getImageMimeFromExtension(imageFormat.ext);
            note.save();

            note.setContent(buffer);
        })
    });

    return {
        fileName,
        note,
        noteId: note.noteId,
        url: `api/images/${note.noteId}/${fileName}`
    };
}

async function shrinkImage(buffer, originalName) {
    const jpegQuality = optionService.getOptionInt('imageJpegQuality');

    let finalImageBuffer;
    try {
        finalImageBuffer = await resize(buffer, jpegQuality);
    }
    catch (e) {
        log.error("Failed to resize image '" + originalName + "'\nStack: " + e.stack);

        finalImageBuffer = buffer;
    }

    // if resizing did not help with size then save the original
    // (can happen when e.g. resizing PNG into JPEG)
    if (finalImageBuffer.byteLength >= buffer.byteLength) {
        finalImageBuffer = buffer;
    }

    return finalImageBuffer;
}

async function resize(buffer, quality) {
    const imageMaxWidthHeight = optionService.getOptionInt('imageMaxWidthHeight');

    const image = await jimp.read(buffer);

    if (image.bitmap.width > image.bitmap.height && image.bitmap.width > imageMaxWidthHeight) {
        image.resize(imageMaxWidthHeight, jimp.AUTO);
    }
    else if (image.bitmap.height > imageMaxWidthHeight) {
        image.resize(jimp.AUTO, imageMaxWidthHeight);
    }

    image.quality(quality);

    // when converting PNG to JPG we lose alpha channel, this is replaced by white to match Trilium white background
    image.background(0xFFFFFFFF);

    return await image.getBufferAsync(jimp.MIME_JPEG);
}

module.exports = {
    saveImage,
    updateImage
};
