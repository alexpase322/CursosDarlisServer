const Course = require('../models/Course');
const cloudinary = require('../config/cloudinary');
const fs = require('fs');

// @desc    Crear un nuevo curso
// @route   POST /api/courses
// @access  Privado (Admin)
const createCourse = async (req, res) => {
    try {
        const { title, description } = req.body;

        let thumbnail = "https://via.placeholder.com/300"; // Imagen por defecto

        // Si suben imagen, la mandamos a Cloudinary
        if (req.file) {
            const result = await cloudinary.uploader.upload(req.file.path, {
                folder: "lms_courses",
                width: 800,
                crop: "scale"
            });
            thumbnail = result.secure_url;
            fs.unlinkSync(req.file.path); // Limpiar servidor
        }

        // Entra al final del listado, igual que módulos y clases.
        const total = await Course.countDocuments();

        const course = await Course.create({
            title,
            description,
            thumbnail,
            order: total,
            instructor: req.user._id // El admin que lo crea es el instructor
        });

        res.status(201).json(course);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al crear el curso' });
    }
};

// @desc    Obtener todos los cursos
// @route   GET /api/courses
// @access  Público (o Privado, según prefieras)
const getAllCourses = async (req, res) => {
    try {
        // .populate trae los datos del instructor en vez de solo su ID
        const courses = await Course.find()
            .populate('instructor', 'username avatar')
            .sort({ order: 1, createdAt: 1 });
        res.json(courses);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener cursos' });
    }
};

// Deduce el tipo de archivo a partir de la URL para poder agrupar y poner
// el icono correcto en el baúl. Si el recurso ya trae un `type` útil, ese manda.
const RESOURCE_TYPES = {
    pdf:   ['pdf'],
    doc:   ['doc', 'docx', 'odt', 'rtf', 'txt'],
    sheet: ['xls', 'xlsx', 'csv', 'ods'],
    slide: ['ppt', 'pptx', 'odp'],
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'],
    audio: ['mp3', 'wav', 'm4a', 'ogg'],
    video: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
    zip:   ['zip', 'rar', '7z']
};

function detectResourceType(resource) {
    const declarado = (resource?.type || '').toLowerCase().trim();
    if (declarado && declarado !== 'file' && declarado !== 'link') return declarado;

    const url = (resource?.url || '').split('?')[0].split('#')[0];
    const ext = (url.split('.').pop() || '').toLowerCase();
    for (const [tipo, exts] of Object.entries(RESOURCE_TYPES)) {
        if (exts.includes(ext)) return tipo;
    }

    // Servicios conocidos que no exponen extensión en la URL.
    if (/drive\.google\.com|docs\.google\.com/i.test(url)) return 'doc';
    if (/canva\.com/i.test(url)) return 'slide';
    if (/youtube\.com|youtu\.be|vimeo\.com|loom\.com/i.test(url)) return 'video';
    if (/notion\.so|notion\.site/i.test(url)) return 'doc';

    return declarado || 'link';
}

// @desc    Baúl de contenido: todos los recursos agrupados por curso y módulo
// @route   GET /api/courses/vault
// @access  Privado (cualquier alumna autenticada)
const getContentVault = async (req, res) => {
    try {
        const courses = await Course.find()
            .select('title thumbnail modules createdAt order')
            .sort({ order: 1, createdAt: 1 })
            .lean();

        let totalResources = 0;
        const tiposPresentes = new Set();

        const salida = courses.map(course => {
            const modules = (course.modules || [])
                .slice()
                .sort((a, b) => (a.order || 0) - (b.order || 0))
                .map(mod => {
                    // Aplanamos los recursos del módulo conservando de qué clase salen:
                    // así el baúl se puede recorrer por módulo sin abrir cada lección.
                    const resources = [];
                    const lessons = (mod.lessons || [])
                        .slice()
                        .sort((a, b) => (a.order || 0) - (b.order || 0));

                    for (const lesson of lessons) {
                        for (const res of (lesson.resources || [])) {
                            if (!res?.url) continue;
                            const type = detectResourceType(res);
                            tiposPresentes.add(type);
                            totalResources += 1;
                            resources.push({
                                _id: String(res._id || ''),
                                label: res.label || 'Recurso sin nombre',
                                url: res.url,
                                type,
                                lessonId: String(lesson._id || ''),
                                lessonTitle: lesson.title || ''
                            });
                        }
                    }

                    return {
                        _id: String(mod._id || ''),
                        title: mod.title || 'Módulo sin título',
                        order: mod.order || 0,
                        resourceCount: resources.length,
                        resources
                    };
                })
                // Los módulos sin material no aportan nada al baúl.
                .filter(m => m.resourceCount > 0);

            return {
                _id: String(course._id),
                title: course.title,
                thumbnail: course.thumbnail || null,
                resourceCount: modules.reduce((n, m) => n + m.resourceCount, 0),
                modules
            };
        }).filter(c => c.resourceCount > 0);

        res.json({
            totalResources,
            totalCourses: salida.length,
            types: [...tiposPresentes].sort(),
            courses: salida
        });
    } catch (error) {
        console.error('[baul] error:', error);
        res.status(500).json({ message: 'Error al cargar el baúl de contenido' });
    }
};

// @desc    Obtener un solo curso
// @route   GET /api/courses/:id
const getCourse = async (req, res) => {
    try {
        const course = await Course.findById(req.params.id)
            .populate('instructor', 'username')
            .populate('modules'); // Traeremos los módulos también
        
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });
        
        res.json(course);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener curso' });
    }
};

// @desc    Actualizar curso (Título, descripción, imagen)
// @route   PUT /api/courses/:id
const updateCourse = async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        // `!== undefined` en vez de `||`: con `||` un campo enviado vacío se
        // confundía con "no enviado" y el error salía como 500 del esquema.
        // Título y descripción son obligatorios en Course, así que se rechazan
        // vacíos con un 400 que la UI puede mostrar.
        if (req.body.title !== undefined) {
            const t = String(req.body.title).trim();
            if (!t) return res.status(400).json({ message: 'El título no puede quedar vacío' });
            course.title = t;
        }
        if (req.body.description !== undefined) {
            const d = String(req.body.description).trim();
            if (!d) return res.status(400).json({ message: 'La descripción no puede quedar vacía' });
            course.description = d;
        }

        // Si hay nueva imagen
        if (req.file) {
             const result = await cloudinary.uploader.upload(req.file.path, {
                folder: "lms_courses",
                width: 800,
                crop: "scale"
            });
            course.thumbnail = result.secure_url;
            fs.unlinkSync(req.file.path);
        }

        const updatedCourse = await course.save();
        res.json(updatedCourse);
    } catch (error) {
        if (error.name === 'ValidationError') {
            return res.status(400).json({ message: Object.values(error.errors)[0]?.message || 'Datos inválidos' });
        }
        console.error('updateCourse', error);
        res.status(500).json({ message: 'Error al actualizar curso' });
    }
};

// @desc    Eliminar curso
// @route   DELETE /api/courses/:id
const deleteCourse = async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        // Usamos deleteOne() porque remove() está obsoleto en Mongoose moderno
        await course.deleteOne(); 
        
        res.json({ message: 'Curso eliminado' });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: 'Error al eliminar curso' });
    }
};

const addModule = async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        const { title } = req.body;
        
        // `order` va al final de la lista: el baúl ordena por este campo, y sin
        // asignarlo todo nacería con 0 y se colaría al principio tras reordenar.
        course.modules.push({ title, lessons: [], order: course.modules.length });
        
        await course.save();
        res.json(course); // Devolvemos el curso completo actualizado
    } catch (error) {
        res.status(500).json({ message: 'Error al agregar módulo' });
    }
};

// @desc    Agregar una Clase (Lección) a un Módulo
// @route   POST /api/courses/:id/modules/:moduleId/lessons
const addLesson = async (req, res) => {
    try {
        const { title, videoUrl, description } = req.body;
        const course = await Course.findById(req.params.id);
        
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        // Buscar el módulo específico dentro del array
        const module = course.modules.id(req.params.moduleId);
        
        if (!module) return res.status(404).json({ message: 'Módulo no encontrado' });

        // Igual que en los módulos: la clase nueva va al final del orden.
        module.lessons.push({ title, videoUrl, description, order: module.lessons.length });

        await course.save();
        res.json(course);
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: 'Error al agregar lección' });
    }
};
// ---------------------------------------------------
// NUEVAS FUNCIONES PARA BORRADO ESPECÍFICO (FASE 6)
// ---------------------------------------------------

// @desc    Eliminar un Módulo específico
// @route   DELETE /api/courses/:id/modules/:moduleId
const deleteModule = async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        // Mongoose Array.pull: Elimina el subdocumento con ese ID
        course.modules.pull(req.params.moduleId);

        await course.save();
        res.json(course); // Devolvemos el curso actualizado
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar módulo' });
    }
};

// @desc    Eliminar una Lección específica
// @route   DELETE /api/courses/:id/modules/:moduleId/lessons/:lessonId
const deleteLesson = async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        // 1. Encontrar el módulo
        const module = course.modules.id(req.params.moduleId);
        if (!module) return res.status(404).json({ message: 'Módulo no encontrado' });

        // 2. Eliminar la lección del array de lecciones de ese módulo
        module.lessons.pull(req.params.lessonId);

        await course.save();
        res.json(course);
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar lección' });
    }
};

// ACTUALIZA TU EXPORT AL FINAL DEL ARCHIVO ASÍ:
// ---------------------------------------------------
// GESTIÓN DE RECURSOS (Archivos/Links por clase)
// ---------------------------------------------------

// @desc    Agregar un recurso a una lección
// @route   POST /api/courses/:id/modules/:moduleId/lessons/:lessonId/resources
const addResource = async (req, res) => {
    const { id, moduleId, lessonId } = req.params;
    const { label, url, type } = req.body; // type puede ser 'file', 'link', 'video', etc.

    try {
        const course = await Course.findById(id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        const module = course.modules.id(moduleId);
        if (!module) return res.status(404).json({ message: 'Módulo no encontrado' });

        const lesson = module.lessons.id(lessonId);
        if (!lesson) return res.status(404).json({ message: 'Lección no encontrada' });

        // Push al array de recursos
        lesson.resources.push({ label, url, type: type || 'file' });

        await course.save();
        res.json(course);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al agregar recurso' });
    }
};

// @desc    Eliminar un recurso de una lección
// @route   DELETE /api/courses/:id/modules/:moduleId/lessons/:lessonId/resources/:resourceId
const deleteResource = async (req, res) => {
    const { id, moduleId, lessonId, resourceId } = req.params;

    try {
        const course = await Course.findById(id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        const module = course.modules.id(moduleId);
        const lesson = module?.lessons.id(lessonId);
        
        if (!lesson) return res.status(404).json({ message: 'Lección no encontrada' });

        // Eliminar recurso del array
        lesson.resources.pull(resourceId);

        await course.save();
        res.json(course);
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar recurso' });
    }
};

// ¡ACTUALIZA EL EXPORT!
// Busca un módulo dentro del curso y devuelve [course, module] o null.
async function findModule(courseId, moduleId) {
    const course = await Course.findById(courseId);
    if (!course) return [null, null];
    return [course, course.modules.id(moduleId)];
}

// @desc    Renombrar / reordenar un módulo
// @route   PUT /api/courses/:id/modules/:moduleId
// @access  Privado (Admin)
const updateModule = async (req, res) => {
    try {
        const [course, mod] = await findModule(req.params.id, req.params.moduleId);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });
        if (!mod) return res.status(404).json({ message: 'Módulo no encontrado' });

        if (req.body.title !== undefined) {
            const t = String(req.body.title).trim();
            if (!t) return res.status(400).json({ message: 'El título del módulo no puede quedar vacío' });
            mod.title = t;
        }
        if (req.body.order !== undefined && Number.isFinite(Number(req.body.order))) {
            mod.order = Number(req.body.order);
        }

        await course.save();
        res.json(course);
    } catch (error) {
        console.error('updateModule', error);
        res.status(500).json({ message: 'Error al actualizar el módulo' });
    }
};

// @desc    Editar una clase (título, video, descripción)
// @route   PUT /api/courses/:id/modules/:moduleId/lessons/:lessonId
// @access  Privado (Admin)
const updateLesson = async (req, res) => {
    try {
        const [course, mod] = await findModule(req.params.id, req.params.moduleId);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });
        if (!mod) return res.status(404).json({ message: 'Módulo no encontrado' });

        const lesson = mod.lessons.id(req.params.lessonId);
        if (!lesson) return res.status(404).json({ message: 'Clase no encontrada' });

        if (req.body.title !== undefined) {
            const t = String(req.body.title).trim();
            if (!t) return res.status(400).json({ message: 'El título de la clase no puede quedar vacío' });
            lesson.title = t;
        }
        if (req.body.videoUrl !== undefined) {
            const v = String(req.body.videoUrl).trim();
            // videoUrl es obligatorio en el esquema: vaciarlo rompería el guardado.
            if (!v) return res.status(400).json({ message: 'La clase necesita una URL de video' });
            lesson.videoUrl = v;
        }
        if (req.body.description !== undefined) {
            lesson.description = String(req.body.description).trim();
        }
        if (req.body.order !== undefined && Number.isFinite(Number(req.body.order))) {
            lesson.order = Number(req.body.order);
        }

        await course.save();
        res.json(course);
    } catch (error) {
        console.error('updateLesson', error);
        res.status(500).json({ message: 'Error al actualizar la clase' });
    }
};

// @desc    Editar un recurso (nombre o enlace)
// @route   PUT /api/courses/:id/modules/:moduleId/lessons/:lessonId/resources/:resourceId
// @access  Privado (Admin)
const updateResource = async (req, res) => {
    try {
        const [course, mod] = await findModule(req.params.id, req.params.moduleId);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });
        if (!mod) return res.status(404).json({ message: 'Módulo no encontrado' });

        const lesson = mod.lessons.id(req.params.lessonId);
        if (!lesson) return res.status(404).json({ message: 'Clase no encontrada' });

        const resource = lesson.resources.id(req.params.resourceId);
        if (!resource) return res.status(404).json({ message: 'Recurso no encontrado' });

        if (req.body.label !== undefined) {
            const l = String(req.body.label).trim();
            if (!l) return res.status(400).json({ message: 'El recurso necesita un nombre' });
            resource.label = l;
        }
        if (req.body.url !== undefined) {
            const u = String(req.body.url).trim();
            if (!u) return res.status(400).json({ message: 'El recurso necesita un enlace' });
            resource.url = u;
        }
        if (req.body.type !== undefined) {
            resource.type = String(req.body.type).trim() || 'file';
        }

        await course.save();
        res.json(course);
    } catch (error) {
        console.error('updateResource', error);
        res.status(500).json({ message: 'Error al actualizar el recurso' });
    }
};

// Comprueba que la lista recibida sea una permutación EXACTA de los ids
// actuales. Si el cliente manda una lista desfasada (porque alguien creó o
// borró algo mientras tanto), se rechaza en vez de perder elementos.
function validarPermutacion(actuales, recibidos) {
    if (!Array.isArray(recibidos)) return 'Falta la lista de orden';
    if (recibidos.length !== actuales.length) return 'La lista de orden no coincide con el contenido actual';
    const a = [...actuales].sort();
    const b = [...recibidos].map(String).sort();
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return 'La lista de orden no coincide con el contenido actual';
    }
    return null;
}

// @desc    Reordenar los módulos de un curso
// @route   PUT /api/courses/:id/modules/reorder
// @access  Privado (Admin)
const reorderModules = async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        const actuales = course.modules.map(m => String(m._id));
        const error = validarPermutacion(actuales, req.body.order);
        if (error) return res.status(400).json({ message: error });

        // Se reordena el ARRAY, no solo el campo `order`: las vistas del curso
        // recorren el array tal cual, así que mover solo `order` no se notaría
        // ahí y además dejaría el baúl (que sí ordena) diciendo otra cosa.
        // Se pasa por toObject() para que Mongoose recast e la lista limpia.
        const ordenados = req.body.order.map((mid, i) => {
            const m = course.modules.id(mid).toObject();
            m.order = i;
            return m;
        });
        course.modules = ordenados;

        await course.save();
        res.json(course);
    } catch (error) {
        console.error('reorderModules', error);
        res.status(500).json({ message: 'Error al reordenar los módulos' });
    }
};

// @desc    Reordenar las clases de un módulo
// @route   PUT /api/courses/:id/modules/:moduleId/lessons/reorder
// @access  Privado (Admin)
const reorderLessons = async (req, res) => {
    try {
        const [course, mod] = await findModule(req.params.id, req.params.moduleId);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });
        if (!mod) return res.status(404).json({ message: 'Módulo no encontrado' });

        const actuales = mod.lessons.map(l => String(l._id));
        const error = validarPermutacion(actuales, req.body.order);
        if (error) return res.status(400).json({ message: error });

        const ordenadas = req.body.order.map((lid, i) => {
            const l = mod.lessons.id(lid).toObject();
            l.order = i;
            return l;
        });
        mod.lessons = ordenadas;

        await course.save();
        res.json(course);
    } catch (error) {
        console.error('reorderLessons', error);
        res.status(500).json({ message: 'Error al reordenar las clases' });
    }
};

// @desc    Mover una clase a otro módulo del mismo curso
// @route   PUT /api/courses/:id/modules/:moduleId/lessons/:lessonId/move
// @access  Privado (Admin)
const moveLesson = async (req, res) => {
    try {
        const { targetModuleId } = req.body;
        if (!targetModuleId) return res.status(400).json({ message: 'Falta el módulo de destino' });

        const course = await Course.findById(req.params.id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        const origen = course.modules.id(req.params.moduleId);
        if (!origen) return res.status(404).json({ message: 'Módulo de origen no encontrado' });

        const destino = course.modules.id(targetModuleId);
        if (!destino) return res.status(404).json({ message: 'Módulo de destino no encontrado' });

        if (String(origen._id) === String(destino._id)) {
            return res.status(400).json({ message: 'La clase ya está en ese módulo' });
        }

        const lesson = origen.lessons.id(req.params.lessonId);
        if (!lesson) return res.status(404).json({ message: 'Clase no encontrada' });

        // Se mueve el subdocumento ENTERO tal cual: conserva su _id, sus
        // recursos y sobre todo `completedBy`, que es donde vive el progreso de
        // las alumnas. Recrearlo desde cero les borraría el avance.
        const copia = lesson.toObject();
        origen.lessons.pull({ _id: lesson._id });

        copia.order = destino.lessons.length;   // entra al final del destino
        destino.lessons.push(copia);

        // El origen queda con un hueco en la numeración: se renumera.
        origen.lessons.forEach((l, i) => { l.order = i; });

        await course.save();
        res.json(course);
    } catch (error) {
        console.error('moveLesson', error);
        res.status(500).json({ message: 'Error al mover la clase' });
    }
};

// @desc    Reordenar los cursos del listado
// @route   PUT /api/courses/reorder
// @access  Privado (Admin)
const reorderCourses = async (req, res) => {
    try {
        const { order } = req.body;
        if (!Array.isArray(order)) return res.status(400).json({ message: 'Falta la lista de orden' });

        const actuales = (await Course.find().select('_id').lean()).map(c => String(c._id));
        const error = validarPermutacion(actuales, order);
        if (error) return res.status(400).json({ message: error });

        // Los cursos son documentos sueltos, no un array: aquí el único orden
        // posible es el campo `order`, y por eso los tres listados lo usan.
        await Course.bulkWrite(
            order.map((cid, i) => ({
                updateOne: { filter: { _id: cid }, update: { $set: { order: i } } }
            }))
        );

        const courses = await Course.find()
            .populate('instructor', 'username avatar')
            .sort({ order: 1, createdAt: 1 });
        res.json(courses);
    } catch (error) {
        console.error('reorderCourses', error);
        res.status(500).json({ message: 'Error al reordenar los cursos' });
    }
};

module.exports = {
    createCourse,
    getAllCourses,
    getContentVault,
    getCourse,
    updateCourse, 
    deleteCourse,
    addModule,   // Nuevo
    addLesson,   // Nuevo
    deleteModule,
    deleteLesson,
    deleteResource,
    addResource,
    updateModule,
    updateLesson,
    updateResource,
    reorderModules,
    reorderLessons,
    moveLesson,
    reorderCourses
};